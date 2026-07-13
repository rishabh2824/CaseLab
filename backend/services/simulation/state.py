"""Run store, lifecycle, availability, and per-persona chat state.

All simulation run state lives behind :class:`RunStore` (the module-level
``run_store`` singleton). The rest of the engine goes through
``run_store.get`` / ``.put`` / ``.mutate`` rather than touching the backing
store or mutating run dicts directly.

Runs are persisted in the ``simulation_runs`` table (one row per run: the run
dict serialized as a JSON blob, an ``expires_at`` deletion deadline, and a
``version`` counter used for optimistic-concurrency writes — see
``RunStore.mutate``). Because the store is the DB, runs survive an API restart
and are shared across workers/instances — the previous single-worker,
lost-on-restart constraint no longer applies, and concurrent writers to the
same run are now a real possibility ``mutate`` guards against via its version
check + retry, rather than the last write silently clobbering an earlier one.
A run row is deleted when it passes ``expires_at`` (whichever is sooner: its
case's ``simulation_duration`` + a short export grace, or a hard
2-hour-from-start cap), enforced both lazily on read (``get``) and by the
background sweeper (``purge_expired``).
"""

import asyncio
import json
import logging
import time

from services.db import get_db_client, row_to_dict

logger = logging.getLogger("caselab.simulations")


class SimulationRunError(Exception):
    """Base for domain errors raised by RunStore.

    These are plain exceptions, not HTTPException — RunStore has no business
    knowing it's being used from a web request, so it stays usable/testable
    outside a request context. main.py registers FastAPI exception handlers
    that translate these to HTTP responses at the app boundary.
    """


class RunNotFound(SimulationRunError):
    """No run exists for this id (never existed, or already purged)."""


class RunExpired(SimulationRunError):
    """The run existed but had passed its TTL and was purged just now."""


class RunWriteConflict(SimulationRunError):
    """mutate() exhausted its retries racing concurrent writers for this run.

    Raised only after repeated optimistic-lock (version) mismatches — see
    RunStore.mutate. Expected to be rare: the frontend already blocks
    same-tab double-submits, so this only fires under genuine cross-tab/
    cross-instance write contention on the same run.
    """


# A run is deleted once its own simulation ends (its case's simulation_duration
# has elapsed) plus this grace window, so a student can still pull a final
# export/read just after the clock runs out. The grace is a memory-hygiene
# allowance, NOT the deadline a student is bound by — that's simulation_duration,
# enforced separately in prepare_message.
RUN_TTL_GRACE_MINUTES = 15
# Hard backstop: no run outlives this many minutes past its start, regardless of
# (or in the absence of) a configured simulation_duration — "deleted
# automatically after 2 hrs from start time".
MAX_RUN_LIFETIME_MINUTES = 120
CLEANUP_INTERVAL_SECONDS = 5 * 60  # how often the background sweeper runs
# classify_message_safety only distinguishes "normal" vs "nonsense" (the
# latter covers gibberish/spam as well as harassment/abuse) — one threshold
# for the one non-normal label.
NONSENSE_END_THRESHOLD = 3


def _compute_expires_at(run: dict) -> float:
    """Absolute unix time at which this run should be deleted.

    Whichever comes first: the run's own end (its case's simulation_duration)
    plus the export grace, or the hard MAX_RUN_LIFETIME cap. Cases without a
    configured duration fall back to the cap. Computed once at ``put`` time from
    the run's fixed start_time + case snapshot, then stored as a column so the
    sweep is a plain indexed DELETE that never has to deserialize a row.
    """
    duration = (run.get("case_snapshot") or {}).get("simulation_duration")
    cap_seconds = MAX_RUN_LIFETIME_MINUTES * 60
    if duration:
        ttl_seconds = min((duration + RUN_TTL_GRACE_MINUTES) * 60, cap_seconds)
    else:
        ttl_seconds = cap_seconds
    return run["start_time"] + ttl_seconds


def _serialize_run(run: dict) -> str:
    """Run dict -> JSON string for the ``data`` column. ``unlocked_referred_ids``
    is a set (not JSON-native), so it's stored as a sorted list and rebuilt as a
    set on load; everything else is already JSON-native."""
    to_store = dict(run)
    to_store["unlocked_referred_ids"] = sorted(run.get("unlocked_referred_ids") or ())
    return json.dumps(to_store)


def _deserialize_run(data: str) -> dict:
    """Inverse of :func:`_serialize_run`: JSON string -> run dict, restoring
    ``unlocked_referred_ids`` to a set."""
    run = json.loads(data)
    run["unlocked_referred_ids"] = set(run.get("unlocked_referred_ids") or ())
    return run


class RunStore:
    """The single owner of simulation run state, backed by the ``simulation_runs``
    table.

    Callers never see the backing store: they ``put`` a new run, ``get`` one to
    read, and funnel every write through ``mutate(run_id, fn)``. ``mutate`` loads
    the row, applies ``fn`` to the deserialized dict, and saves it back under an
    optimistic-lock (``version``) check, retrying on conflict — so the service
    layer keeps mutating a plain dict in place (``fn``), oblivious to the
    load/save round-trip or the locking. All methods are async because the DB
    client is.

    Every ``fn`` passed to ``mutate`` MUST be free of I/O with an *observable*
    side effect (another DB write, a notification, a billing call, ...): on a
    version conflict, ``fn`` runs again against a freshly re-fetched run, so a
    side-effecting ``fn`` would double-fire. Calling a pure computation (e.g.
    generating a presigned URL — local HMAC signing, no network call, and the
    URL itself is never persisted) is fine; the invariant is about I/O whose
    effect would be wrong to repeat.
    """

    async def put(self, run_id: str, run: dict) -> None:
        """Insert a freshly-built run under ``run_id``."""
        client = get_db_client()
        await client.execute(
            "insert into simulation_runs (run_id, expires_at, data, version) "
            "values (?, ?, ?, 0)",
            (run_id, _compute_expires_at(run), _serialize_run(run)),
        )

    async def _get_row(self, run_id: str) -> tuple[dict, int]:
        """Return (run dict, version), lazily deleting the row if it has
        passed ``expires_at``. Shared by ``get`` and ``mutate``.

        Raises RunNotFound / RunExpired (see main.py for the HTTP translation)
        rather than HTTPException — a missing/expired run is a normal, expected
        condition here, not a FastAPI-specific concern.
        """
        client = get_db_client()
        result = await client.execute(
            "select data, expires_at, version from simulation_runs where run_id = ?",
            (run_id,),
        )
        if not result.rows:
            raise RunNotFound(run_id)
        row = row_to_dict(result.rows[0])
        if time.time() > row["expires_at"]:
            await client.execute(
                "delete from simulation_runs where run_id = ?", (run_id,)
            )
            raise RunExpired(run_id)
        return _deserialize_run(row["data"]), row["version"]

    async def get(self, run_id: str) -> dict:
        """Return the run, lazily deleting it if it has passed ``expires_at``.

        Read-only callers don't need the version — only ``mutate`` does.
        """
        run, _version = await self._get_row(run_id)
        return run

    async def mutate(self, run_id: str, fn, *, max_retries: int = 5):
        """Load the run, apply ``fn``, persist it under an optimistic-lock
        check, and return ``fn``'s result.

        ``fn`` receives the deserialized run dict and mutates it in place; its
        return value (if any) is handed back to the caller. This is the ONLY
        sanctioned write path. The write is conditioned on ``version`` matching
        what was just read (``UPDATE ... WHERE run_id = ? AND version = ?`` and
        bumping it); if another writer won the race in between (rows_affected
        == 0), the whole read-mutate-write is retried from a fresh read, up to
        ``max_retries`` times, since ``fn`` needs to see the other writer's
        delta to compute a correct result rather than clobber it. Exhausting
        retries raises RunWriteConflict — expected to be rare (see that
        exception's docstring). ``expires_at`` is fixed at ``put`` time (the
        deletion deadline is anchored to start_time), so a mutation only ever
        rewrites ``data`` and ``version``.
        """
        client = get_db_client()
        for attempt in range(max_retries):
            run, version = await self._get_row(run_id)  # also enforces not-found / expired
            result = fn(run)
            update_result = await client.execute(
                "update simulation_runs set data = ?, version = version + 1 "
                "where run_id = ? and version = ?",
                (_serialize_run(run), run_id, version),
            )
            if update_result.rows_affected:
                return result
            logger.warning(
                "Lost update race on run %s (attempt %d/%d), retrying",
                run_id, attempt + 1, max_retries,
            )
        raise RunWriteConflict(run_id)

    async def purge_expired(self) -> int:
        """Delete every run past its ``expires_at``. Returns the count removed.

        Runs on a background sweeper, and lazily via ``get``, so an expired run
        is gone whether or not anyone touches it again.
        """
        client = get_db_client()
        result = await client.execute(
            "delete from simulation_runs where expires_at < ?", (time.time(),)
        )
        count = result.rows_affected
        if count:
            logger.info("Purged %d expired simulation run(s)", count)
        return count


run_store = RunStore()


async def cleanup_expired_runs_forever(interval: int = CLEANUP_INTERVAL_SECONDS) -> None:
    """Background loop that periodically purges expired runs.

    Started from the FastAPI lifespan in main.py and cancelled on shutdown.
    """
    while True:
        await asyncio.sleep(interval)
        try:
            await run_store.purge_expired()
        except Exception:
            logger.exception("Error while purging expired simulation runs")


def _elapsed_minutes(run) -> int:
    return int((time.time() - run["start_time"]) / 60)


def _persona_availability(persona, available_at_minutes: int, elapsed_minutes: int):
    availability_duration = persona.get("availability_duration")
    available_at = available_at_minutes
    if elapsed_minutes < available_at:
        return {
            "available": False,
            "available_in": available_at - elapsed_minutes,
            "expires_in": None,
        }
    if availability_duration:
        expires_at = available_at + availability_duration
        if elapsed_minutes > expires_at:
            return {
                "available": False,
                "available_in": None,
                "expires_in": 0,
            }
        return {
            "available": True,
            "available_in": 0,
            "expires_in": max(0, expires_at - elapsed_minutes),
        }
    return {"available": True, "available_in": 0, "expires_in": None}


def _new_chat_state() -> dict:
    return {
        "warning_count": 0,
        "ended": False,
        "end_reason": None,
        "last_flag_type": None,
    }


def _get_persona_chat_state(run: dict, persona_id: str) -> dict:
    """Read a persona's chat (safety) state, or a fresh default if it has never
    been flagged. Pure read: it does NOT create state on the run — writes go
    through ``run_store.mutate`` + ``_persona_chat_state_ref`` (see
    prepare_message)."""
    return run.get("persona_chat_state", {}).get(persona_id) or _new_chat_state()


def _persona_chat_state_ref(run: dict, persona_id: str) -> dict:
    """Get-or-create the live, stored chat-state dict for a persona so it can be
    mutated. Only call this INSIDE a ``run_store.mutate`` callback — it writes to
    the run."""
    return run.setdefault("persona_chat_state", {}).setdefault(persona_id, _new_chat_state())


def _chat_state_payload_from_state(state: dict) -> dict:
    return {
        "chat_ended": state["ended"],
        "chat_end_reason": state["end_reason"],
        "warning_count": state["warning_count"],
    }


def _chat_state_payload(run: dict, persona_id: str) -> dict:
    return _chat_state_payload_from_state(_get_persona_chat_state(run, persona_id))


def _build_boundary_reply(persona_name: str, should_end: bool) -> str:
    name = persona_name or "I"
    if should_end:
        return (
            f"{name} is ending this conversation because the messages are not coherent or "
            "respectful enough to continue. Please send clear, respectful case-related "
            "questions to another contact."
        )
    return (
        "I am not able to follow that. Please send a clear, respectful, case-related "
        "question if you want to continue."
    )


def _format_run_histories(run: dict, persona_ids: set[str] | None = None) -> dict:
    histories = {}
    for persona_id, messages in run["history"].items():
        if persona_ids is not None and persona_id not in persona_ids:
            continue
        histories[persona_id] = [
            {
                "role": message.get("role"),
                "content": message.get("content", ""),
            }
            for message in messages
            if message.get("role") in {"user", "assistant"}
        ]
    return histories
