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
import logging
import re
import time
import uuid

from fastapi import HTTPException

from models.simulations import SendMessagePayload, StartSimulationPayload
from services import simulation_repository as repo
from services.db import get_db_client
from services.llm import (
    chat_completion_structured,
    classify_condition,
    classify_message_safety,
    classify_referral,
    generate_contact_introduction,
)
from services.spaces import create_presigned_get_url
from settings import get_settings

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


def _format_persona_row(row):
    (
        persona_id,
        name,
        role,
        photo_bucket,
        photo_object_key,
        photo_file_name,
        photo_content_type,
        scheduled_time,
        availability_duration,
    ) = row
    return {
        "id": persona_id,
        "name": name,
        "role": role,
        "profile_photo": (
            {
                "bucket": photo_bucket,
                "object_key": photo_object_key,
                "file_name": photo_file_name,
                "content_type": photo_content_type,
                "url": create_presigned_get_url(photo_object_key),
            }
            if photo_bucket and photo_object_key and photo_file_name
            else None
        ),
        "scheduled_time": scheduled_time,
        "availability_duration": availability_duration,
    }


async def _get_case_snapshot(client, access_code: str | None = None, case_id: str | None = None):
    row = await repo.fetch_case_snapshot(client, access_code=access_code, case_id=case_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No case found.")
    (
        case_id,
        case_name,
        initial_brief,
        simulation_duration,
        common_information,
        resolved_access_code,
    ) = row
    return {
        "id": case_id,
        "case_name": case_name,
        "initial_brief": initial_brief,
        "simulation_duration": simulation_duration,
        "common_information": common_information,
        "access_code": resolved_access_code,
    }


async def _get_root_personas(client, case_id):
    rows = await repo.fetch_root_personas(client, case_id)
    return [_format_persona_row(row) for row in rows]


async def _get_persona_details(client, persona_id):
    row = await repo.fetch_persona_core(client, persona_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
    (
        name,
        role,
        photo_bucket,
        photo_object_key,
        photo_file_name,
        photo_content_type,
        known,
        unknown,
        hidden,
        traits,
    ) = row
    files = await repo.fetch_persona_file_entries(client, persona_id)
    file_entries = [
        {
            "file_id": file_id,
            "bucket": bucket,
            "object_key": object_key,
            "file_name": file_name,
            "content_type": content_type,
            "share_conditions": share_conditions,
            "perceived_contents": perceived_contents,
        }
        for (
            file_id,
            bucket,
            object_key,
            file_name,
            content_type,
            share_conditions,
            perceived_contents,
        ) in files
    ]
    return {
        "name": name,
        "role": role,
        "profile_photo": (
            {
                "bucket": photo_bucket,
                "object_key": photo_object_key,
                "file_name": photo_file_name,
                "content_type": photo_content_type,
                "url": create_presigned_get_url(photo_object_key),
            }
            if photo_bucket and photo_object_key and photo_file_name
            else None
        ),
        "known_facts": known,
        "unknown_facts": unknown,
        "hidden_facts": hidden,
        "personality_traits": traits,
        "files": file_entries,
    }


async def _get_referrals_for_parent(client, case_id, parent_persona_id):
    rows = await repo.fetch_referrals_for_parent(client, case_id, parent_persona_id)
    referrals = []
    for row in rows:
        (
            referred_persona_id,
            trigger_type,
            condition_trigger,
            time_trigger,
            name,
            role,
            photo_bucket,
            photo_object_key,
            photo_file_name,
            photo_content_type,
            scheduled_time,
            availability_duration,
        ) = row
        referrals.append(
            {
                "referred_persona_id": referred_persona_id,
                "trigger_type": trigger_type,
                "condition_trigger": condition_trigger or "",
                "time_trigger": time_trigger,
                "persona": {
                    "id": referred_persona_id,
                    "name": name,
                    "role": role,
                    "profile_photo": (
                        {
                            "bucket": photo_bucket,
                            "object_key": photo_object_key,
                            "file_name": photo_file_name,
                            "content_type": photo_content_type,
                            "url": create_presigned_get_url(photo_object_key),
                        }
                        if photo_bucket and photo_object_key and photo_file_name
                        else None
                    ),
                    "scheduled_time": scheduled_time,
                    "availability_duration": availability_duration,
                    "is_referred": True,
                },
            }
        )
    return referrals


# --- prompt building & classification helpers ------------------------------


def _build_system_prompt(case_snapshot, persona_details, locked_referral_names=None):
    file_lines = []
    for entry in persona_details["files"]:
        file_name = entry["file_name"] or "Unnamed file"
        share_conditions = entry["share_conditions"] or "No conditions specified"
        perceived_contents = entry["perceived_contents"] or "No description"
        file_lines.append(
            f"- {file_name} (share conditions: {share_conditions}; perceived contents: {perceived_contents})"
        )
    files_section = "\n".join(file_lines) if file_lines else "None"
    suppression = ""
    if locked_referral_names:
        suppression = (
            "\nDo NOT mention, introduce, or hint at these contacts yet: "
            f"{', '.join(locked_referral_names)}. "
            "Speak as if you do not have a specific person to refer to."
        )
    known_facts = persona_details.get("known_facts") or "None"
    if locked_referral_names and known_facts:
        for name in locked_referral_names:
            known_facts = re.sub(
                rf"\b{re.escape(name)}\b",
                "[undisclosed contact]",
                known_facts,
            )
    return (
        "You are a persona in a case simulation. Stay in character.\n"
        "Respond naturally and conversationally in 1-3 concise sentences.\n"
        f"Case summary: {case_snapshot['initial_brief']}\n"
        f"Common information: {case_snapshot.get('common_information') or 'None'}\n"
        f"Persona name: {persona_details['name']}\n"
        f"Role/title: {persona_details['role']}\n"
        f"Personality traits: {persona_details.get('personality_traits') or 'None'}\n"
        f"Information you know: {known_facts}\n"
        "Never fabricate details outside your known facts. If asked about unknown facts, say you do not know.\n"
        f"Files you have access to:\n{files_section}\n"
        "Do not share files unless the user has satisfied the sharing conditions."
        f"{suppression}"
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


def _build_structured_instruction() -> str:
    return (
        "You must reply in strict JSON with one key:\n"
        '  - "reply": string\n'
        "Return ONLY JSON with no code fences and no extra text.\n"
        "Keep reply to 1-3 sentences."
    )


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
    case_snapshot = await _get_case_snapshot(client, case_id=run["case_id"])
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
    case_snapshot = await _get_case_snapshot(client, case_id=run["case_id"])
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


async def handle_message(run_id: str, payload: SendMessagePayload):
    run = _get_run(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    settings = get_settings()
    if not persona_id or not user_message:
        raise HTTPException(status_code=400, detail="persona_id and message are required.")
    elapsed_minutes = _elapsed_minutes(run)
    # Check availability for root/referred persona
    client = get_db_client()
    case_snapshot = await _get_case_snapshot(client, case_id=run["case_id"])
    root_personas = await _get_root_personas(client, case_snapshot["id"])
    root_map = {p["id"]: p for p in root_personas}
    if persona_id in root_map:
        availability = _persona_availability(
            root_map[persona_id],
            root_map[persona_id].get("scheduled_time") or 0,
            elapsed_minutes,
        )
    elif persona_id in run["unlocked_referred_ids"]:
        persona_rows = await repo.fetch_persona_row(client, persona_id)
        if not persona_rows:
            raise HTTPException(status_code=404, detail="Persona not found.")
        persona = _format_persona_row(persona_rows[0])
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

    referrals = await _get_referrals_for_parent(client, case_snapshot["id"], persona_id)
    locked_referral_names = [
        ref["persona"]["name"]
        for ref in referrals
        if ref["referred_persona_id"] not in run["unlocked_referred_ids"]
    ]
    persona_details = await _get_persona_details(client, persona_id)
    history = run["history"].setdefault(persona_id, [])
    filtered_history = [msg for msg in history if msg.get("role") != "system"]
    history_for_classifier = filtered_history + [
        {"role": "user", "content": user_message}
    ]
    message_label = await classify_message_safety(user_message, history_for_classifier)
    if settings.sim_debug:
        print("SIM DEBUG: message safety ->", message_label)
    if message_label != "normal":
        history.append({"role": "user", "content": user_message})
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
        history.append({"role": "assistant", "content": assistant_reply})
        return {
            "reply": assistant_reply,
            "history": _format_run_histories(run, {persona_id}).get(persona_id, []),
            "new_contacts": [],
            "shared_files": [],
            **_chat_state_payload(run, persona_id),
        }
    system_prompt = _build_system_prompt(
        case_snapshot, persona_details, locked_referral_names
    )
    structured_instruction = _build_structured_instruction()
    if settings.sim_debug:
        print(
            "SIM DEBUG: prompt lengths ->",
            len(system_prompt),
            len(structured_instruction),
        )
        print(
            "SIM DEBUG: referrals ->",
            [
                {
                    "id": ref["referred_persona_id"],
                    "trigger_type": ref["trigger_type"],
                }
                for ref in referrals
            ],
        )
    sanitized_history = _sanitize_history(filtered_history, locked_referral_names)
    combined_system = f"{structured_instruction}\n\n---\n\n{system_prompt}"
    messages = [
        {"role": "system", "content": combined_system},
        *sanitized_history,
        {"role": "user", "content": user_message},
    ]
    history.append({"role": "user", "content": user_message})
    try:
        result = await chat_completion_structured(messages)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="LLM request timed out.") from exc
    assistant_reply = result["reply"]
    history_for_classifier = sanitized_history + [{"role": "user", "content": user_message}]

    newly_unlocked = []
    for referral in referrals:
        referred_id = referral["referred_persona_id"]
        if referred_id in run["unlocked_referred_ids"]:
            continue
        if referral["trigger_type"] == "conditions":
            condition = referral["condition_trigger"].strip()
            if condition:
                min_messages = _extract_min_message_threshold(condition)
                if min_messages is not None:
                    current_count = _count_user_messages(history)
                    should_unlock = current_count >= min_messages
                else:
                    should_unlock = await classify_referral(condition, history_for_classifier)
                if settings.sim_debug:
                    print(
                        "SIM DEBUG: referral condition ->",
                        condition,
                        "result ->",
                        should_unlock,
                    )
                if should_unlock:
                    run["unlocked_referred_ids"].add(referred_id)
                    run["unlocked_at"][referred_id] = elapsed_minutes
                    newly_unlocked.append(
                        {
                            **referral["persona"],
                            **_chat_state_payload(run, referred_id),
                        }
                    )
        elif referral["trigger_type"] == "time":
            if referral["time_trigger"] and elapsed_minutes >= referral["time_trigger"]:
                run["unlocked_referred_ids"].add(referred_id)
                run["unlocked_at"][referred_id] = elapsed_minutes
                newly_unlocked.append(
                    {
                        **referral["persona"],
                        **_chat_state_payload(run, referred_id),
                    }
                )
    if settings.sim_debug:
        print("SIM DEBUG: newly_unlocked ->", newly_unlocked)

    if newly_unlocked:
        intro = await generate_contact_introduction(
            persona_details,
            newly_unlocked,
            history_for_classifier[-6:],
        )
        assistant_reply = f"{assistant_reply} {intro}"
    history.append({"role": "assistant", "content": assistant_reply})

    shared_files = []
    for file_entry in persona_details["files"]:
        file_id = file_entry.get("file_id")
        if not file_id or file_id in run["shared_files"]:
            continue
        condition = (file_entry.get("share_conditions") or "").strip()
        if not condition:
            continue
        should_share = await classify_condition(condition, history_for_classifier)
        if settings.sim_debug:
            print("SIM DEBUG: file condition ->", condition, "result ->", should_share)
        if should_share:
            url = create_presigned_get_url(file_entry["object_key"])
            shared_info = {
                "file_id": file_id,
                "file_name": file_entry.get("file_name") or "file",
                "content_type": file_entry.get("content_type"),
                "url": url,
            }
            run["shared_files"][file_id] = shared_info
            shared_files.append(shared_info)

    return {
        "reply": assistant_reply,
        "history": _format_run_histories(run, {persona_id}).get(persona_id, []),
        "new_contacts": newly_unlocked,
        "shared_files": shared_files,
        **_chat_state_payload(run, persona_id),
    }
