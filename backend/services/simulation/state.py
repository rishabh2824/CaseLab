"""Run store, lifecycle, availability, and per-persona chat state.

All simulation run state lives behind :class:`RunStore` (the module-level
``run_store`` singleton). The rest of the engine goes through
``run_store.get`` / ``.put`` / ``.mutate`` rather than touching the backing
store or mutating run dicts directly — so the current per-process in-memory
implementation could be swapped for Redis/a DB by reimplementing just those
methods, with no change to callers.

NOTE: the current store is per-process in-memory. Runs are lost on restart and
are NOT shared across workers/instances, so the API must be run with a single
worker on a single instance.
"""

import asyncio
import logging
import time

from fastapi import HTTPException

from settings import MAX_SIMULATION_DURATION_MINUTES

logger = logging.getLogger("caselab.simulations")

# Grace period past the longest a case's own simulation_duration is allowed to
# be (MAX_SIMULATION_DURATION_MINUTES, enforced at case creation), so a run
# survives long enough for a final export/read after time's up. This TTL is a
# memory-hygiene backstop, NOT the deadline a student is bound by — that's
# simulation_duration, enforced separately in prepare_message.
RUN_TTL_GRACE_MINUTES = 15
RUN_TTL_SECONDS = (MAX_SIMULATION_DURATION_MINUTES + RUN_TTL_GRACE_MINUTES) * 60
CLEANUP_INTERVAL_SECONDS = 5 * 60  # how often the background sweeper runs
# classify_message_safety only distinguishes "normal" vs "nonsense" (the
# latter covers gibberish/spam as well as harassment/abuse) — one threshold
# for the one non-normal label.
NONSENSE_END_THRESHOLD = 3


class RunStore:
    """The single owner of simulation run state.

    Callers never see the backing store: they ``put`` a new run, ``get`` one to
    read, and funnel every write through ``mutate(run_id, fn)``. For this
    in-memory implementation a mutation persists the moment ``fn`` touches the
    dict, so ``mutate`` is a thin wrapper — but routing all writes through it
    means a future persistent backend only has to add a load/save around this
    one method (and reimplement ``get``/``put``/``purge_expired``), instead of
    chasing scattered ``run[...] = ...`` assignments across the service layer.
    """

    def __init__(self) -> None:
        self._runs: dict[str, dict] = {}

    def put(self, run_id: str, run: dict) -> None:
        """Store a freshly-built run under ``run_id``."""
        self._runs[run_id] = run

    def get(self, run_id: str) -> dict:
        """Return the run, lazily purging (and 404ing) if it has expired."""
        run = self._runs.get(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Simulation run not found.")
        if time.time() - run["start_time"] > RUN_TTL_SECONDS:
            del self._runs[run_id]
            raise HTTPException(status_code=404, detail="Simulation run expired.")
        return run

    def mutate(self, run_id: str, fn):
        """Apply ``fn`` to the run and return its result.

        ``fn`` receives the live run dict and mutates it in place; its return
        value (if any) is handed back to the caller. This is the ONLY sanctioned
        write path — a persistent backend would load the run, run ``fn``, then
        save, all inside here.
        """
        run = self.get(run_id)
        return fn(run)

    def purge_expired(self) -> int:
        """Drop every run older than RUN_TTL_SECONDS. Returns the count removed.

        Runs on a background sweeper, and lazily via ``get``, so an expired run
        is gone whether or not anyone touches it again.
        """
        now = time.time()
        expired = [
            run_id
            for run_id, run in self._runs.items()
            if now - run["start_time"] > RUN_TTL_SECONDS
        ]
        for run_id in expired:
            del self._runs[run_id]
        if expired:
            logger.info(
                "Purged %d expired simulation run(s); %d still active",
                len(expired),
                len(self._runs),
            )
        return len(expired)


run_store = RunStore()


async def cleanup_expired_runs_forever(interval: int = CLEANUP_INTERVAL_SECONDS) -> None:
    """Background loop that periodically purges expired runs.

    Started from the FastAPI lifespan in main.py and cancelled on shutdown.
    """
    while True:
        await asyncio.sleep(interval)
        try:
            run_store.purge_expired()
        except Exception:
            logger.exception("Error while purging expired simulation runs")


def _elapsed_minutes(run) -> int:
    return int((time.time() - run["start_time"]) / 60)


def _persona_availability(persona, available_at_minutes: int, elapsed_minutes: int):
    scheduled_time = persona.get("scheduled_time") or 0
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


def _chat_state_payload(run: dict, persona_id: str) -> dict:
    state = _get_persona_chat_state(run, persona_id)
    return {
        "chat_ended": state["ended"],
        "chat_end_reason": state["end_reason"],
        "warning_count": state["warning_count"],
    }


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
