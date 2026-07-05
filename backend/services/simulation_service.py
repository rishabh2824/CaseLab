"""Simulation engine.

Holds the in-memory run store and all simulation logic: availability windows,
prompt building, safety handling, referral unlocking, and file sharing. The
router layer (`api/simulations.py`) only forwards requests to the operations at
the bottom of this module.

NOTE: ``RUNS`` is per-process in-memory state. Runs are lost on restart and are
NOT shared across workers/instances, so the API must be run with a single
worker on a single instance.
"""

import asyncio
import json
import logging
import re
import time
import uuid

from fastapi import HTTPException

from models.simulations import SendMessagePayload, StartSimulationPayload
from services import simulation_repository as repo
from services.db import get_db_client
from services.llm import (
    chat_completion_stream,
    classify_file_share,
    classify_message_safety,
    classify_referral,
)
from services.spaces import create_presigned_get_url

logger = logging.getLogger("caselab.simulations")

RUNS: dict[str, dict] = {}
RUN_TTL_SECONDS = 60 * 60 * 2  # a run is removed 2 hours after it starts
CLEANUP_INTERVAL_SECONDS = 5 * 60  # how often the background sweeper runs
NONSENSE_END_THRESHOLD = 3
HARASSMENT_END_THRESHOLD = 2


def purge_expired_runs() -> int:
    """Remove every run older than RUN_TTL_SECONDS. Returns the count removed.

    Called both by the background sweeper and lazily by _get_run, so an expired
    run is gone whether or not anyone touches it again.
    """
    now = time.time()
    expired = [
        run_id
        for run_id, run in RUNS.items()
        if now - run["start_time"] > RUN_TTL_SECONDS
    ]
    for run_id in expired:
        del RUNS[run_id]
    if expired:
        logger.info(
            "Purged %d expired simulation run(s); %d still active",
            len(expired),
            len(RUNS),
        )
    return len(expired)


async def cleanup_expired_runs_forever(interval: int = CLEANUP_INTERVAL_SECONDS) -> None:
    """Background loop that periodically purges expired runs.

    Started from the FastAPI lifespan in main.py and cancelled on shutdown.
    """
    while True:
        await asyncio.sleep(interval)
        try:
            purge_expired_runs()
        except Exception:
            logger.exception("Error while purging expired simulation runs")


# --- chat state ------------------------------------------------------------


def _get_persona_chat_state(run: dict, persona_id: str) -> dict:
    persona_chat_state = run.setdefault("persona_chat_state", {})
    return persona_chat_state.setdefault(
        persona_id,
        {
            "warning_count": 0,
            "ended": False,
            "end_reason": None,
            "last_flag_type": None,
        },
    )


def _chat_state_payload(run: dict, persona_id: str) -> dict:
    state = _get_persona_chat_state(run, persona_id)
    return {
        "chat_ended": state["ended"],
        "chat_end_reason": state["end_reason"],
        "warning_count": state["warning_count"],
    }


def _build_boundary_reply(persona_name: str, label: str, should_end: bool) -> str:
    name = persona_name or "I"
    if should_end:
        if label == "severe_abuse":
            return (
                f"{name} is ending this conversation now because of abusive language. "
                "Please continue the case respectfully with another contact."
            )
        if label == "harassment":
            return (
                f"{name} is ending this conversation now because the messages have become disrespectful. "
                "Please continue the case respectfully with another contact."
            )
        return (
            f"{name} is ending this conversation because the messages are not coherent enough to continue. "
            "Please send clear case-related questions to another contact."
        )
    if label == "harassment":
        return (
            "I can help with the case, but I will not continue if the messages stay disrespectful or harassing."
        )
    return (
        "I am not able to follow that. Please send a clear, case-related question if you want to continue."
    )


# --- persona / case reads (shaping around the repository) ------------------


def _format_persona_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "profile_photo": (
            {
                "bucket": row["bucket"],
                "object_key": row["object_key"],
                "file_name": row["file_name"],
                "content_type": row["content_type"],
                "url": create_presigned_get_url(row["object_key"]),
            }
            if row["bucket"] and row["object_key"] and row["file_name"]
            else None
        ),
        "scheduled_time": row["scheduled_time"],
        "availability_duration": row["availability_duration"],
    }


async def _get_case_snapshot(client, access_code: str | None = None, case_id: str | None = None):
    row = await repo.fetch_case_snapshot(client, access_code=access_code, case_id=case_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No case found.")
    return {
        "id": row["id"],
        "case_name": row["case_name"],
        "initial_brief": row["initial_brief"],
        "simulation_duration": row["simulation_duration"],
        "common_information": row["common_information"],
        "access_code": row["access_code"],
    }


async def _get_run_case_snapshot(run: dict, client):
    """CaseForm snapshot for a run, cached on the run.

    The case is fixed for the life of a run, so re-querying it on every message
    is wasted work. The snapshot holds no presigned URLs, so caching it is safe
    (unlike persona/file rows, whose URLs expire and are re-signed each read).
    """
    cached = run.get("case_snapshot")
    if cached is not None:
        return cached
    snapshot = await _get_case_snapshot(client, case_id=run["case_id"])
    run["case_snapshot"] = snapshot
    return snapshot


async def _get_root_personas(client, case_id):
    rows = await repo.fetch_root_personas(client, case_id)
    return [_format_persona_row(row) for row in rows]


async def _get_persona_details(client, persona_id):
    # The two reads are independent; run them as concurrent HTTP requests.
    persona, files = await asyncio.gather(
        repo.fetch_persona_core(client, persona_id),
        repo.fetch_persona_file_entries(client, persona_id),
    )
    if persona is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    file_entries = [
        {
            "file_id": row["id"],
            "bucket": row["bucket"],
            "object_key": row["object_key"],
            "file_name": row["file_name"],
            "content_type": row["content_type"],
            "share_conditions": row["share_conditions"],
            "perceived_contents": row["perceived_contents"],
        }
        for row in files
    ]
    return {
        "name": persona["name"],
        "role": persona["role"],
        "profile_photo": (
            {
                "bucket": persona["bucket"],
                "object_key": persona["object_key"],
                "file_name": persona["file_name"],
                "content_type": persona["content_type"],
                "url": create_presigned_get_url(persona["object_key"]),
            }
            if persona["bucket"] and persona["object_key"] and persona["file_name"]
            else None
        ),
        "known_facts": persona["known_facts"],
        "unknown_facts": persona["unknown_facts"],
        "hidden_facts": persona["hidden_facts"],
        "personality_traits": persona["personality_traits"],
        "files": file_entries,
    }


async def _get_referrals_for_parent(client, case_id, parent_persona_id):
    rows = await repo.fetch_referrals_for_parent(client, case_id, parent_persona_id)
    referrals = []
    for row in rows:
        referred_persona_id = row["referred_persona_id"]
        referrals.append(
            {
                "referred_persona_id": referred_persona_id,
                "trigger_type": row["trigger_type"],
                "condition_trigger": row["condition_trigger"] or "",
                "time_trigger": row["time_trigger"],
                "persona": {
                    "id": referred_persona_id,
                    "name": row["name"],
                    "role": row["role"],
                    "profile_photo": (
                        {
                            "bucket": row["bucket"],
                            "object_key": row["object_key"],
                            "file_name": row["file_name"],
                            "content_type": row["content_type"],
                            "url": create_presigned_get_url(row["object_key"]),
                        }
                        if row["bucket"] and row["object_key"] and row["file_name"]
                        else None
                    ),
                    "scheduled_time": row["scheduled_time"],
                    "availability_duration": row["availability_duration"],
                    "is_referred": True,
                },
            }
        )
    return referrals


# --- prompt building & classification helpers ------------------------------


def _build_system_prompt(
    case_snapshot,
    persona_details,
    *,
    locked_referral_names,
    newly_unlocked_contacts,
    newly_shared_file_names,
    withheld_file_names,
):
    """Build the persona's system prompt, GROUNDED in the decisions already made
    for this turn.

    The referral/file unlock decisions are resolved before this is called, so
    the prompt tells the persona exactly what it may and may not do — rather
    than the persona improvising a referral/file offer that the mechanical
    checks then contradict.
    """
    known_facts = persona_details.get("known_facts") or "None"
    # Redact still-locked contacts from the facts the model sees, so it can't
    # surface a name it isn't allowed to reveal yet.
    if locked_referral_names and known_facts != "None":
        for name in locked_referral_names:
            known_facts = re.sub(
                rf"\b{re.escape(name)}\b",
                "[undisclosed contact]",
                known_facts,
            )

    # --- referral guidance ---
    referral_lines = []
    if newly_unlocked_contacts:
        contacts = ", ".join(
            f"{c['name']} ({c['role']})" for c in newly_unlocked_contacts
        )
        referral_lines.append(
            "You have JUST decided to connect the user with a new contact. Introduce "
            f"them naturally in your reply: {contacts}."
        )
    if locked_referral_names:
        referral_lines.append(
            "Do NOT mention, introduce, hint at, or offer to connect the user with "
            f"anyone else, including: {', '.join(locked_referral_names)}. Speak as if "
            "you have no other specific person to refer them to."
        )
    if not newly_unlocked_contacts:
        referral_lines.append(
            "You are NOT introducing any new contact this turn. Do not promise or offer "
            "to connect the user with anyone."
        )
    referral_section = " ".join(referral_lines)

    # --- file guidance ---
    file_lines = []
    if newly_shared_file_names:
        file_lines.append(
            "You are sharing the following file(s) with the user right now (they are "
            f"being delivered alongside your reply): {', '.join(newly_shared_file_names)}. "
            "Mention them naturally."
        )
    if withheld_file_names:
        file_lines.append(
            "You possess the following file(s) but must NOT share, send, or offer to "
            f"send them this turn: {', '.join(withheld_file_names)}."
        )
    if not newly_shared_file_names:
        file_lines.append(
            "You are NOT sharing any file this turn. Do not claim to send, attach, or "
            "provide a file."
        )
    file_section = " ".join(file_lines)

    return (
        "You are a persona in a case simulation. Stay in character.\n"
        "Respond naturally and conversationally in 1-3 concise sentences.\n"
        f"CaseForm summary: {case_snapshot['initial_brief']}\n"
        f"Common information: {case_snapshot.get('common_information') or 'None'}\n"
        f"Persona name: {persona_details['name']}\n"
        f"Role/title: {persona_details['role']}\n"
        f"Personality traits: {persona_details.get('personality_traits') or 'None'}\n"
        f"Information you know: {known_facts}\n"
        "Never fabricate details outside your known facts. If asked about unknown facts, say you do not know.\n"
        f"Referrals: {referral_section}\n"
        f"Files: {file_section}\n"
        "Strict rule: only introduce a contact or share a file if explicitly permitted "
        "above. Never promise, imply, or offer a referral or file that is not listed as "
        "available this turn."
    )


def _extract_min_message_threshold(condition: str) -> int | None:
    match = re.search(r"after\s+at\s+least\s+(\d+)\s+messages?", condition, re.IGNORECASE)
    if match:
        return int(match.group(1))
    return None


def _count_user_messages(history: list[dict]) -> int:
    return sum(1 for msg in history if msg.get("role") == "user")


def _sanitize_history(history: list[dict], locked_names: list[str]) -> list[dict]:
    if not locked_names:
        return history
    sanitized = []
    for msg in history:
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            for name in locked_names:
                content = re.sub(rf"\b{re.escape(name)}\b", "my contact", content)
            sanitized.append({**msg, "content": content})
        else:
            sanitized.append(msg)
    return sanitized


def _build_reply_instruction() -> str:
    return (
        "Reply in plain text, in character, in 1-3 concise sentences. "
        "Do not use JSON, code fences, quotation marks around the whole reply, "
        "or a speaker-name prefix."
    )


def _clean_reply(text: str) -> str:
    reply = (text or "").strip()
    # Strip a leading bracketed speaker tag like "[Mary, CFO ...]" if the model
    # emits one despite the instruction.
    reply = re.sub(r"^\s*\[[^\]]+\]\s*", "", reply).strip()
    return reply


def _sse(event: str, data: dict) -> dict:
    """One Server-Sent Event as an sse-starlette dict; the response class
    handles the wire framing (and keep-alive pings / disconnect detection)."""
    return {"event": event, "data": json.dumps(data)}


async def _resolve_referral_unlock(
    referral: dict,
    decision_history: list[dict],
    elapsed_minutes: int,
) -> bool:
    """Whether this referral's trigger is satisfied right now. The only case
    that hits the network is an unconditioned "conditions" trigger; time
    triggers and message-count thresholds resolve locally.

    ``decision_history`` is the conversation including the current user message
    (so message-count thresholds count this turn)."""
    if referral["trigger_type"] == "conditions":
        condition = referral["condition_trigger"].strip()
        if not condition:
            return False
        min_messages = _extract_min_message_threshold(condition)
        if min_messages is not None:
            return _count_user_messages(decision_history) >= min_messages
        return await classify_referral(condition, decision_history)
    if referral["trigger_type"] == "time":
        return bool(referral["time_trigger"] and elapsed_minutes >= referral["time_trigger"])
    return False


async def _resolve_file_share(file_entry: dict, decision_history: list[dict]) -> bool:
    condition = (file_entry.get("share_conditions") or "").strip()
    if not condition:
        return False
    return await classify_file_share(condition, decision_history)


# --- run lifecycle ---------------------------------------------------------


def _get_run(run_id: str) -> dict:
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Simulation run not found.")
    if time.time() - run["start_time"] > RUN_TTL_SECONDS:
        del RUNS[run_id]
        raise HTTPException(status_code=404, detail="Simulation run expired.")
    return run


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


# --- operations (called by the router) -------------------------------------


async def start_simulation(payload: StartSimulationPayload):
    client = get_db_client()
    access_code = payload.access_code.strip()
    if not access_code:
        raise HTTPException(status_code=400, detail="Access code is required.")
    case_snapshot = await _get_case_snapshot(client, access_code=access_code)
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    if not root_personas:
        raise HTTPException(status_code=400, detail="No root personas found.")
    available = [p for p in root_personas if (p["scheduled_time"] or 0) == 0]
    initial_persona = available[0] if available else root_personas[0]
    run_id = uuid.uuid4().hex
    RUNS[run_id] = {
        "case_id": case_snapshot["id"],
        "case_snapshot": case_snapshot,  # cached for the life of the run
        "start_time": time.time(),
        "active_persona_id": initial_persona["id"],
        "unlocked_referred_ids": set(),
        "unlocked_at": {},
        "shared_files": {},
        "history": {},
        "persona_chat_state": {},
    }
    elapsed_minutes = _elapsed_minutes(RUNS[run_id])
    contacts = []
    for persona in root_personas:
        availability = _persona_availability(
            persona,
            persona.get("scheduled_time") or 0,
            elapsed_minutes,
        )
        contacts.append(
            {
                **persona,
                **availability,
                "is_referred": False,
                **_chat_state_payload(RUNS[run_id], persona["id"]),
            }
        )
    active_candidates = [c for c in contacts if c["available"]]
    if active_candidates:
        RUNS[run_id]["active_persona_id"] = active_candidates[0]["id"]
    return {
        "run_id": run_id,
        "case": {
            "id": case_snapshot["id"],
            "case_name": case_snapshot["case_name"],
            "initial_brief": case_snapshot["initial_brief"],
            "simulation_duration": case_snapshot["simulation_duration"],
        },
        "contacts": contacts,
        "active_persona_id": RUNS[run_id]["active_persona_id"],
        "shared_files": [],
        "histories": {},
    }


async def get_simulation_state(run_id: str):
    run = _get_run(run_id)
    client = get_db_client()
    case_snapshot = await _get_run_case_snapshot(run, client)
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    unlocked_ids = run["unlocked_referred_ids"]
    elapsed_minutes = _elapsed_minutes(run)
    contacts = []
    for persona in root_personas:
        availability = _persona_availability(
            persona,
            persona.get("scheduled_time") or 0,
            elapsed_minutes,
        )
        contacts.append(
            {
                **persona,
                **availability,
                "is_referred": False,
                **_chat_state_payload(run, persona["id"]),
            }
        )
    referred = []
    if unlocked_ids:
        rows = await repo.fetch_personas_by_ids(client, unlocked_ids)
        for row in rows:
            persona = _format_persona_row(row)
            available_at = run["unlocked_at"].get(persona["id"], elapsed_minutes)
            availability = _persona_availability(
                persona,
                available_at,
                elapsed_minutes,
            )
            referred.append(
                {
                    **persona,
                    **availability,
                    "is_referred": True,
                    **_chat_state_payload(run, persona["id"]),
                }
            )
    contacts = contacts + referred
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
        "shared_files": list(run["shared_files"].values()),
        "histories": _format_run_histories(run, visible_persona_ids),
    }


async def export_simulation_history(run_id: str):
    run = _get_run(run_id)
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
    for this turn. Reads run state but does NOT mutate it — the caller applies
    the results only if the message passes the safety check.

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
    """Validate the turn, resolve/apply unlocks & shares, and build the reply
    inputs — everything up to (but not including) generating the reply.

    Returns a "prepared" dict consumed by stream_message. Raises HTTPException
    for any client error, which must happen HERE (before streaming starts) so
    the client gets a normal error status rather than a half-open stream.
    """
    run = _get_run(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise HTTPException(status_code=400, detail="persona_id and message are required.")
    elapsed_minutes = _elapsed_minutes(run)
    # Check availability for root/referred persona
    client = get_db_client()
    case_snapshot = await _get_run_case_snapshot(run, client)
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
    run["active_persona_id"] = persona_id
    chat_state = _get_persona_chat_state(run, persona_id)
    if chat_state["ended"]:
        raise HTTPException(status_code=400, detail="This conversation has ended.")

    # Record the user's turn once (kept by both the safety and normal paths).
    history = run["history"].setdefault(persona_id, [])
    history.append({"role": "user", "content": user_message})
    # Full conversation incl. this message; used by the safety + unlock/share
    # judges and (sanitized) as the reply context.
    decision_history = [msg for msg in history if msg.get("role") != "system"]

    # Safety only needs the in-memory conversation, so run it CONCURRENTLY with
    # fetching persona data + resolving the unlock/share decisions. On the common
    # (non-abusive) path this hides the safety round-trip entirely. Decisions are
    # computed eagerly but only APPLIED below if the message passes safety.
    message_label, decisions = await asyncio.gather(
        classify_message_safety(user_message, decision_history),
        _resolve_turn_decisions(
            client, case_snapshot["id"], persona_id, decision_history, run, elapsed_minutes
        ),
    )
    referrals = decisions["referrals"]
    persona_details = decisions["persona_details"]

    if message_label != "normal":
        chat_state["last_flag_type"] = message_label
        if message_label == "severe_abuse":
            chat_state["ended"] = True
            chat_state["end_reason"] = message_label
        else:
            chat_state["warning_count"] += 1
            threshold = (
                HARASSMENT_END_THRESHOLD
                if message_label == "harassment"
                else NONSENSE_END_THRESHOLD
            )
            if chat_state["warning_count"] >= threshold:
                chat_state["ended"] = True
                chat_state["end_reason"] = message_label
        assistant_reply = _build_boundary_reply(
            persona_details["name"],
            message_label,
            chat_state["ended"],
        )
        # The boundary reply is a canned string; stream_message appends it to
        # history and emits it as a single delta.
        return {
            "kind": "boundary",
            "run": run,
            "persona_id": persona_id,
            "reply": assistant_reply,
            "meta": {
                "new_contacts": [],
                "shared_files": [],
                **_chat_state_payload(run, persona_id),
            },
        }

    # --- normal message: apply the decisions resolved above, then ground the
    # persona's reply in that real outcome ---
    pending_referrals = decisions["pending_referrals"]
    pending_files = decisions["pending_files"]
    referral_results = decisions["referral_results"]
    file_results = decisions["file_results"]

    # Apply referral unlocks.
    newly_unlocked = []
    for referral, should_unlock in zip(pending_referrals, referral_results):
        referred_id = referral["referred_persona_id"]
        if should_unlock:
            run["unlocked_referred_ids"].add(referred_id)
            run["unlocked_at"][referred_id] = elapsed_minutes
            newly_unlocked.append(
                {**referral["persona"], **_chat_state_payload(run, referred_id)}
            )

    # Apply file shares.
    shared_files = []
    for file_entry, should_share in zip(pending_files, file_results):
        if should_share:
            file_id = file_entry["file_id"]
            shared_info = {
                "file_id": file_id,
                "file_name": file_entry.get("file_name") or "file",
                "content_type": file_entry.get("content_type"),
                "url": create_presigned_get_url(file_entry["object_key"]),
            }
            run["shared_files"][file_id] = shared_info
            shared_files.append(shared_info)

    # Ground the persona's prompt in the decisions just made.
    still_locked_names = [
        ref["persona"]["name"]
        for ref in referrals
        if ref["referred_persona_id"] not in run["unlocked_referred_ids"]
    ]
    newly_unlocked_contacts = [
        {"name": c["name"], "role": c["role"]} for c in newly_unlocked
    ]
    newly_shared_file_names = [info["file_name"] for info in shared_files]
    withheld_file_names = [
        file_entry.get("file_name") or "a file"
        for file_entry in persona_details["files"]
        if not file_entry.get("file_id")
        or file_entry["file_id"] not in run["shared_files"]
    ]

    system_prompt = _build_system_prompt(
        case_snapshot,
        persona_details,
        locked_referral_names=still_locked_names,
        newly_unlocked_contacts=newly_unlocked_contacts,
        newly_shared_file_names=newly_shared_file_names,
        withheld_file_names=withheld_file_names,
    )
    reply_instruction = _build_reply_instruction()

    # Sanitize prior assistant turns against names that remain locked; these
    # messages are the reply context.
    sanitized_history = _sanitize_history(decision_history, still_locked_names)
    combined_system = f"{reply_instruction}\n\n---\n\n{system_prompt}"
    messages = [{"role": "system", "content": combined_system}, *sanitized_history]

    return {
        "kind": "normal",
        "run": run,
        "persona_id": persona_id,
        "messages": messages,
        "meta": {
            "new_contacts": newly_unlocked,
            "shared_files": shared_files,
            **_chat_state_payload(run, persona_id),
        },
    }


async def stream_message(prepared: dict):
    """Async generator of Server-Sent Events for one message turn.

    Emits, in order:
      - ``meta``  : new_contacts / shared_files / chat-state (already decided)
      - ``delta`` : reply text chunks (one for a canned boundary reply, many
                    when streaming the model)
      - ``done``  : the final cleaned reply + updated history
    or a single ``error`` event if generation fails mid-stream.
    """
    run = prepared["run"]
    persona_id = prepared["persona_id"]

    yield _sse("meta", prepared["meta"])

    if prepared["kind"] == "boundary":
        reply = prepared["reply"]
        if reply:
            yield _sse("delta", {"text": reply})
    else:
        parts: list[str] = []
        try:
            async for chunk in chat_completion_stream(prepared["messages"]):
                parts.append(chunk)
                yield _sse("delta", {"text": chunk})
        except Exception:
            logger.exception("Streaming reply failed for persona %s", persona_id)
            yield _sse(
                "error",
                {"detail": "The reply could not be generated. Please try again."},
            )
            return
        reply = _clean_reply("".join(parts))

    run["history"].setdefault(persona_id, []).append(
        {"role": "assistant", "content": reply}
    )
    yield _sse(
        "done",
        {
            "reply": reply,
            "history": _format_run_histories(run, {persona_id}).get(persona_id, []),
        },
    )
