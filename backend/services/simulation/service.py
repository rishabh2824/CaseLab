"""Orchestration: the operations the router (``api/simulations.py``) calls,
composed from ``state``, ``reads``, ``prompt``, and ``repository``."""

import asyncio
import json
import logging
import time
import uuid

from fastapi import HTTPException

from models.simulations import SendMessagePayload, StartSimulationPayload
from services import debug_log
from services.db import get_db_client
from services.llm import classify_message_safety, complete_persona_reply
from services.simulation import repository as repo
from services.simulation.prompt import (
    _build_reply_instruction,
    _build_system_prompt,
    _clean_reply,
    _coerce_handles,
    _parse_reply_envelope,
    _resolve_file_share,
    _resolve_referral_unlock,
    _sanitize_history,
)
from services.simulation.reads import (
    _format_persona_row,
    _get_case_snapshot,
    _get_persona_details,
    _get_referrals_for_parent,
    _get_root_personas,
    _get_run_case_snapshot,
)
from services.simulation.state import (
    NONSENSE_END_THRESHOLD,
    _build_boundary_reply,
    _chat_state_payload,
    _elapsed_minutes,
    _format_run_histories,
    _get_persona_chat_state,
    _persona_availability,
    _persona_chat_state_ref,
    run_store,
)
from services.spaces import create_presigned_get_url

logger = logging.getLogger("caselab.simulations")

# Cap on how much of a persona's history rides along as conversation context
# for the frontier reply model (see _prepare_reply's `recent_history`). The
# unlock/share judges still see the FULL `decision_history` (message-count
# thresholds and condition checks need it) — only the frontier call's context
# is capped.
RECENT_HISTORY_MESSAGE_LIMIT = 6


def _sse(event: str, data: dict) -> dict:
    """One Server-Sent Event as an sse-starlette dict; the response class
    handles the wire framing (and keep-alive pings / disconnect detection)."""
    return {"event": event, "data": json.dumps(data)}


def _build_contact(run, persona, available_at_minutes, elapsed_minutes, *, is_referred):
    """One contact-list entry: persona fields + computed availability + chat
    state. Shared by start_simulation (root only) and get_simulation_state
    (root + unlocked referred), which previously duplicated this inline."""
    availability = _persona_availability(persona, available_at_minutes, elapsed_minutes)
    return {
        **persona,
        **availability,
        "is_referred": is_referred,
        **_chat_state_payload(run, persona["id"]),
    }


def _build_contacts(run, root_personas, elapsed_minutes, referred_rows=None):
    """Full contacts list for an API response: every root persona, plus (if
    given) every unlocked referred persona — each shaped identically."""
    contacts = [
        _build_contact(
            run, persona, persona.get("scheduled_time") or 0, elapsed_minutes, is_referred=False
        )
        for persona in root_personas
    ]
    for row in referred_rows or []:
        persona = _format_persona_row(row)
        available_at = run["unlocked_at"].get(persona["id"], elapsed_minutes)
        contacts.append(
            _build_contact(run, persona, available_at, elapsed_minutes, is_referred=True)
        )
    return contacts


async def start_simulation(payload: StartSimulationPayload):
    client = get_db_client()
    access_code = payload.access_code.strip()
    if not access_code:
        raise HTTPException(status_code=400, detail="Access code is required.")
    case_snapshot = await _get_case_snapshot(client, access_code=access_code)
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    if not root_personas:
        raise HTTPException(status_code=400, detail="No root personas found.")
    run_id = uuid.uuid4().hex
    # Build the run fully (including the resolved active persona) before handing
    # it to the store, so creation is a single put() rather than an insert
    # followed by nested mutations. active_persona_id starts as a naive
    # placeholder (the first root persona) — the contacts pass below always
    # corrects it to the first AVAILABLE persona when one exists. It only
    # survives when none are, which (at elapsed_minutes ~0, right after
    # start_time is set) means every persona has scheduled_time > 0 — the
    # same "nobody's up yet" case this placeholder already covers.
    run = {
        "case_id": case_snapshot["id"],
        "case_snapshot": case_snapshot,  # cached for the life of the run
        "start_time": time.time(),
        "active_persona_id": root_personas[0]["id"],
        "unlocked_referred_ids": set(),
        "unlocked_at": {},
        "shared_files": {},
        "history": {},
        "persona_chat_state": {},
    }
    elapsed_minutes = _elapsed_minutes(run)
    contacts = _build_contacts(run, root_personas, elapsed_minutes)
    active_candidates = [c for c in contacts if c["available"]]
    if active_candidates:
        run["active_persona_id"] = active_candidates[0]["id"]
    run_store.put(run_id, run)
    return {
        "run_id": run_id,
        "case": {
            "id": case_snapshot["id"],
            "case_name": case_snapshot["case_name"],
            "initial_brief": case_snapshot["initial_brief"],
            "simulation_duration": case_snapshot["simulation_duration"],
        },
        "contacts": contacts,
        "active_persona_id": run["active_persona_id"],
        "shared_files": [],
        "histories": {},
    }


async def get_simulation_state(run_id: str):
    run = run_store.get(run_id)
    client = get_db_client()
    case_snapshot = await _get_run_case_snapshot(run, client)
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    unlocked_ids = run["unlocked_referred_ids"]
    elapsed_minutes = _elapsed_minutes(run)
    referred_rows = await repo.fetch_personas_by_ids(client, unlocked_ids) if unlocked_ids else []
    contacts = _build_contacts(run, root_personas, elapsed_minutes, referred_rows)
    visible_persona_ids = {persona["id"] for persona in contacts}
    return {
        "run_id": run_id,
        "case": {
            "id": case_snapshot["id"],
            "case_name": case_snapshot["case_name"],
            "initial_brief": case_snapshot["initial_brief"],
            "simulation_duration": case_snapshot["simulation_duration"],
        },
        "contacts": contacts,
        "active_persona_id": run["active_persona_id"],
        "shared_files": [_shared_file_payload(info) for info in run["shared_files"].values()],
        "histories": _format_run_histories(run, visible_persona_ids),
    }


async def export_simulation_history(run_id: str):
    run = run_store.get(run_id)
    client = get_db_client()
    case_snapshot = await _get_run_case_snapshot(run, client)
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    unlocked_ids = run["unlocked_referred_ids"]
    personas = [{**persona, "is_referred": False} for persona in root_personas]

    if unlocked_ids:
        rows = await repo.fetch_personas_by_ids(client, unlocked_ids)
        referred_personas = [
            {**_format_persona_row(row), "is_referred": True}
            for row in rows
        ]
        referred_personas.sort(
            key=lambda persona: run["unlocked_at"].get(persona["id"], 0)
        )
        personas.extend(referred_personas)

    return {
        "case": {
            "id": case_snapshot["id"],
            "case_name": case_snapshot["case_name"],
        },
        "personas": [
            {
                "id": persona["id"],
                "name": persona["name"],
                "role": persona["role"],
                "messages": [
                    {
                        "role": message.get("role"),
                        "content": message.get("content", ""),
                    }
                    for message in run["history"].get(persona["id"], [])
                    if message.get("role") in {"user", "assistant"}
                ],
            }
            for persona in personas
        ],
    }


async def _resolve_turn_decisions(
    client, case_id, persona_id, decision_history, run, elapsed_minutes
) -> dict:
    """Fetch the persona's referrals + details and resolve every unlock/share
    eligibility for this turn. Reads run state but does NOT mutate it — the
    caller applies the results only if the message passes the safety check.

    Runs concurrently with the safety classifier (which needs no DB), so the
    two cheap-model waves overlap instead of running back to back.
    """
    referrals, persona_details = await asyncio.gather(
        _get_referrals_for_parent(client, case_id, persona_id),
        _get_persona_details(client, persona_id),
    )
    pending_referrals = [
        referral
        for referral in referrals
        if referral["referred_persona_id"] not in run["unlocked_referred_ids"]
    ]
    pending_files = [
        file_entry
        for file_entry in persona_details["files"]
        if file_entry.get("file_id") and file_entry["file_id"] not in run["shared_files"]
    ]
    referral_results, file_results = await asyncio.gather(
        asyncio.gather(
            *(
                _resolve_referral_unlock(referral, decision_history, elapsed_minutes)
                for referral in pending_referrals
            )
        ),
        asyncio.gather(
            *(_resolve_file_share(file_entry, decision_history) for file_entry in pending_files)
        ),
    )
    return {
        "referrals": referrals,
        "persona_details": persona_details,
        "pending_referrals": pending_referrals,
        "pending_files": pending_files,
        "referral_results": referral_results,
        "file_results": file_results,
    }


async def prepare_message(run_id: str, payload: SendMessagePayload) -> dict:
    """Validate the turn, resolve which unlocks/shares are ELIGIBLE this turn,
    and build the reply inputs — everything up to (but not including) generating
    the reply. The unlock/share decisions themselves are made by the persona
    model during generation and applied in stream_message, so nothing is mutated
    into run state here (beyond recording the user's message and chat state).

    Returns a "prepared" dict consumed by stream_message. Raises HTTPException
    for any client error, which must happen HERE (before streaming starts) so
    the client gets a normal error status rather than a half-open stream.
    """
    run = run_store.get(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise HTTPException(status_code=400, detail="persona_id and message are required.")
    elapsed_minutes = _elapsed_minutes(run)
    client = get_db_client()
    case_snapshot = await _get_run_case_snapshot(run, client)
    # Server-side enforcement of the case's configured deadline. The frontend
    # also redirects itself once its own clock runs out (a UX nicety, not a
    # guarantee — a student bypassing it, e.g. via DevTools or curl, could
    # otherwise keep messaging past the deadline indefinitely). This is the
    # actual cutoff.
    simulation_duration = case_snapshot.get("simulation_duration")
    if simulation_duration and elapsed_minutes >= simulation_duration:
        raise HTTPException(status_code=400, detail="This simulation has ended.")
    # Check availability for root/referred persona
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    root_map = {p["id"]: p for p in root_personas}
    if persona_id in root_map:
        availability = _persona_availability(
            root_map[persona_id],
            root_map[persona_id].get("scheduled_time") or 0,
            elapsed_minutes,
        )
    elif persona_id in run["unlocked_referred_ids"]:
        persona_row = await repo.fetch_persona_row(client, persona_id)
        if persona_row is None:
            raise HTTPException(status_code=404, detail="Persona not found.")
        persona = _format_persona_row(persona_row)
        available_at = run["unlocked_at"].get(persona_id, elapsed_minutes)
        availability = _persona_availability(persona, available_at, elapsed_minutes)
    else:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    if not availability["available"]:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    run_store.mutate(run_id, lambda r: r.update({"active_persona_id": persona_id}))
    if _get_persona_chat_state(run, persona_id)["ended"]:
        raise HTTPException(status_code=400, detail="This conversation has ended.")

    # Record the user's turn once (kept by both the safety and normal paths).
    def _record_user_turn(r):
        turns = r["history"].setdefault(persona_id, [])
        turns.append({"role": "user", "content": user_message})
        return turns

    history = run_store.mutate(run_id, _record_user_turn)
    # Full conversation incl. this message; used by the safety + unlock/share
    # judges and (sanitized) as the reply context.
    decision_history = [msg for msg in history if msg.get("role") != "system"]

    debug_log.user_message(persona_id, user_message)

    # Safety only needs the in-memory conversation, so run it CONCURRENTLY with
    # fetching persona data + resolving the unlock/share decisions. On the common
    # (non-abusive) path this hides the safety round-trip entirely. Decisions are
    # computed eagerly but only APPLIED below if the message passes safety.
    #
    # _resolve_turn_decisions can raise (the referral/file judges no longer fail
    # closed on an outage -- see _yes_no_judge), so this whole turn is aborted
    # with a clear error rather than silently treating an outage as "nothing is
    # eligible this turn".
    try:
        message_label, decisions = await asyncio.gather(
            classify_message_safety(user_message, decision_history),
            _resolve_turn_decisions(
                client, case_snapshot["id"], persona_id, decision_history, run, elapsed_minutes
            ),
        )
    except Exception:
        logger.exception("Failed to resolve turn decisions for persona %s", persona_id)
        raise HTTPException(
            status_code=502, detail="Could not process your message. Please try again."
        )
    persona_details = decisions["persona_details"]

    if message_label != "normal":
        # Update the persona's safety state as one mutation, returning the new
        # state so we can decide whether this turn also ends the conversation.
        # message_label is always "nonsense" here (the only non-normal label);
        # the chat ends once it's been sent NONSENSE_END_THRESHOLD times.
        def _flag_persona(r):
            state = _persona_chat_state_ref(r, persona_id)
            state["last_flag_type"] = message_label
            state["warning_count"] += 1
            if state["warning_count"] >= NONSENSE_END_THRESHOLD:
                state["ended"] = True
                state["end_reason"] = message_label
            return state

        chat_state = run_store.mutate(run_id, _flag_persona)
        assistant_reply = _build_boundary_reply(
            persona_details["name"],
            chat_state["ended"],
        )
        # The boundary reply is a canned string; stream_message appends it to
        # history and emits it as a single delta.
        return {
            "kind": "boundary",
            "run_id": run_id,
            "persona_id": persona_id,
            "reply": assistant_reply,
            "meta": {
                "new_contacts": [],
                "shared_files": [],
                **_chat_state_payload(run, persona_id),
            },
        }

    # --- normal message: the unlock/share DECISIONS are made by the persona
    # model itself (in the same generation that writes the reply), so here we
    # only compute what it is ELIGIBLE to offer and hand that to the prompt.
    # Nothing is applied to run state until stream_message parses the reply. ---
    pending_referrals = decisions["pending_referrals"]
    pending_files = decisions["pending_files"]
    referral_results = decisions["referral_results"]
    file_results = decisions["file_results"]

    # Referrals whose trigger fired this turn become handle-tagged options the
    # persona MAY introduce; the rest stay hidden and are redacted from context.
    eligible_referrals = []
    forbidden_referral_names = []
    referral_handles = {}
    for referral, is_eligible in zip(pending_referrals, referral_results):
        if is_eligible:
            handle = f"R{len(eligible_referrals) + 1}"
            persona = referral["persona"]
            eligible_referrals.append(
                {"handle": handle, "name": persona["name"], "role": persona["role"]}
            )
            referral_handles[handle] = referral
        else:
            forbidden_referral_names.append(referral["persona"]["name"])

    # Files whose share condition fired become handle-tagged options; the rest
    # (including any the persona holds but can't share yet) are withheld.
    eligible_files = []
    file_handles = {}
    for file_entry, is_eligible in zip(pending_files, file_results):
        if is_eligible:
            handle = f"F{len(eligible_files) + 1}"
            eligible_files.append(
                {"handle": handle, "name": file_entry.get("file_name") or "file"}
            )
            file_handles[handle] = file_entry
    eligible_file_ids = {fe.get("file_id") for fe in file_handles.values()}
    withheld_file_names = [
        file_entry.get("file_name") or "a file"
        for file_entry in persona_details["files"]
        if not file_entry.get("file_id")
        or (
            file_entry["file_id"] not in run["shared_files"]
            and file_entry["file_id"] not in eligible_file_ids
        )
    ]

    stable_prompt, turn_prompt = _build_system_prompt(
        case_snapshot,
        persona_details,
        forbidden_referral_names=forbidden_referral_names,
        eligible_referrals=eligible_referrals,
        eligible_files=eligible_files,
        withheld_file_names=withheld_file_names,
    )
    reply_instruction = _build_reply_instruction()

    # Sanitize prior assistant turns against names that remain forbidden, then
    # keep only the most recent turns as the model's conversation context —
    # older turns are dropped rather than sent (and billed) in full every
    # message. decision_history (unsliced) is still what the unlock/share
    # judges saw above, so eligibility decisions aren't affected by this cap.
    sanitized_history = _sanitize_history(decision_history, forbidden_referral_names)
    recent_history = sanitized_history[-RECENT_HISTORY_MESSAGE_LIMIT:]
    # Prompt caching: the reply-format instruction + the persona's stable facts
    # (case brief, common info, known facts) go in ONE content block marked
    # cache_control=ephemeral, ttl=1h. Anthropic (via OpenRouter) caches that
    # prefix, so across a persona's turns it's processed/billed once per
    # ~1-hour window instead of re-sent in full every message. 1h (2x write
    # cost) over the 5m default (1.25x write cost) because students plausibly
    # go several minutes between messages (reading a brief/file, deliberating)
    # — long enough to miss a 5-minute window repeatedly within one ~2-hour-max
    # run, forcing a fresh full-price write each time. The per-turn
    # referral/file guidance is a SEPARATE, uncached block after it — it
    # changes turn to turn (eligibility/unlock/share), so folding it into the
    # cached block would bust the cache on every such change. The conversation
    # history (now capped to RECENT_HISTORY_MESSAGE_LIMIT turns) follows,
    # uncached — it was already uncached before the cap, and the cache
    # breakpoint above only ever covered the system block, so trimming history
    # doesn't touch cache hit rate either way.
    cached_prompt = f"{reply_instruction}\n\n---\n\n{stable_prompt}"
    messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": cached_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                },
                {"type": "text", "text": turn_prompt},
            ],
        },
        *recent_history,
    ]

    return {
        "kind": "normal",
        "run_id": run_id,
        "persona_id": persona_id,
        "messages": messages,
        "referral_handles": referral_handles,
        "file_handles": file_handles,
    }


def _shared_file_payload(info: dict) -> dict:
    """Re-sign a previously-shared file's download URL from its stored
    object_key. Presigned URLs expire (SPACES_PRESIGN_EXPIRY_SECONDS, 900s by
    default) well before a run's ~2-hour lifetime, so the URL must be generated
    fresh on every read rather than cached at share time — caching it made
    links start 403ing partway through a still-active simulation."""
    return {
        "file_id": info["file_id"],
        "file_name": info["file_name"],
        "content_type": info["content_type"],
        "url": create_presigned_get_url(info["object_key"]),
    }


def _apply_reply_decisions(run_id, prepared, unlock_handles, share_handles):
    """Enact only the referral/file decisions the persona actually made AND was
    permitted to make: a handle is honored only if it's in the eligible map built
    for this turn (so the model can never unlock a persona whose condition wasn't
    met, or one that isn't even configured). The whole apply is one atomic
    run-state mutation; returns the (new_contacts, shared_files) to announce."""
    referral_handles = prepared["referral_handles"]
    file_handles = prepared["file_handles"]

    def _apply(run):
        elapsed_minutes = _elapsed_minutes(run)
        new_contacts = []
        for handle in dict.fromkeys(unlock_handles):  # de-dupe, preserve order
            referral = referral_handles.get(handle)
            if referral is None:
                continue
            referred_id = referral["referred_persona_id"]
            if referred_id in run["unlocked_referred_ids"]:
                continue
            run["unlocked_referred_ids"].add(referred_id)
            run["unlocked_at"][referred_id] = elapsed_minutes
            new_contacts.append(
                {**referral["persona"], **_chat_state_payload(run, referred_id)}
            )

        shared_files = []
        for handle in dict.fromkeys(share_handles):
            file_entry = file_handles.get(handle)
            if file_entry is None:
                continue
            file_id = file_entry.get("file_id")
            if not file_id or file_id in run["shared_files"]:
                continue
            shared_info = {
                "file_id": file_id,
                "file_name": file_entry.get("file_name") or "file",
                "content_type": file_entry.get("content_type"),
                "object_key": file_entry["object_key"],
            }
            run["shared_files"][file_id] = shared_info
            shared_files.append(_shared_file_payload(shared_info))

        return new_contacts, shared_files

    return run_store.mutate(run_id, _apply)


def _append_assistant_turn(run, persona_id, reply):
    """Append the assistant reply to a persona's history and return that
    persona's formatted history. Call INSIDE a run_store.mutate callback."""
    run["history"].setdefault(persona_id, []).append(
        {"role": "assistant", "content": reply}
    )
    return _format_run_histories(run, {persona_id}).get(persona_id, [])


async def stream_message(prepared: dict):
    """Async generator of Server-Sent Events for one message turn.

    A boundary reply is canned, so its meta + text are known up front. A normal
    reply is generated first (buffered), because the persona's own output carries
    the referral/file decisions — only after parsing it do we know what to unlock,
    share, and announce.

    Emits, in order: ``meta`` (new_contacts / shared_files / chat-state), then
    ``delta`` (the reply text), then ``done`` (final reply + history) — or a
    single ``error`` event if generation fails, in which case nothing is unlocked
    or shared.
    """
    run_id = prepared["run_id"]
    persona_id = prepared["persona_id"]

    if prepared["kind"] == "boundary":
        yield _sse("meta", prepared["meta"])
        reply = prepared["reply"]
        if reply:
            yield _sse("delta", {"text": reply})
        history = run_store.mutate(
            run_id, lambda r: _append_assistant_turn(r, persona_id, reply)
        )
        yield _sse("done", {"reply": reply, "history": history})
        return

    # --- normal: generate the whole envelope, parse it, then apply + announce ---
    try:
        raw = await complete_persona_reply(prepared["messages"])
    except Exception:
        logger.exception("Reply generation failed for persona %s", persona_id)
        yield _sse(
            "error",
            {"detail": "The reply could not be generated. Please try again."},
        )
        return

    envelope = _parse_reply_envelope(raw)
    reply = _clean_reply(str(envelope.get("reply") or "")) if envelope else ""
    if not reply:
        logger.error("Reply envelope did not parse for persona %s: %r", persona_id, raw)
        yield _sse(
            "error",
            {"detail": "The reply could not be generated. Please try again."},
        )
        return
    unlock_handles = _coerce_handles(envelope.get("introduce"))
    share_handles = _coerce_handles(envelope.get("send_files"))

    debug_log.persona_reply_cleaned(reply, unlock_handles, share_handles)

    new_contacts, shared_files = _apply_reply_decisions(
        run_id, prepared, unlock_handles, share_handles
    )

    if debug_log.enabled():
        referral_handles = prepared["referral_handles"]
        file_handles = prepared["file_handles"]
        claimed_contact_names = [
            referral_handles[h]["persona"]["name"]
            for h in dict.fromkeys(unlock_handles)
            if h in referral_handles
        ]
        claimed_file_names = [
            file_handles[h].get("file_name") or "file"
            for h in dict.fromkeys(share_handles)
            if h in file_handles
        ]
        debug_log.applied_outcome(
            claimed_contact_names,
            [c["name"] for c in new_contacts],
            claimed_file_names,
            [f["file_name"] for f in shared_files],
        )

    yield _sse(
        "meta",
        {
            "new_contacts": new_contacts,
            "shared_files": shared_files,
            **_chat_state_payload(run_store.get(run_id), persona_id),
        },
    )
    yield _sse("delta", {"text": reply})
    history = run_store.mutate(
        run_id, lambda r: _append_assistant_turn(r, persona_id, reply)
    )
    yield _sse("done", {"reply": reply, "history": history})
