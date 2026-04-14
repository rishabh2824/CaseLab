import time
import uuid
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.db.turso import get_db_client
from app.core.settings import get_settings
from app.services.llm import (chat_completion_structured, classify_referral, classify_condition)
from app.services.llm import generate_contact_introduction
from app.services.spaces import create_presigned_get_url

router = APIRouter(prefix="/simulations", tags=["simulations"])

RUNS: dict[str, dict] = {}
RUN_TTL_SECONDS = 60 * 60 * 4


class StartSimulationPayload(BaseModel):
    access_code: str


def _format_persona_row(row):
    (
        persona_id,
        name,
        role,
        scheduled_time,
        availability_duration,
    ) = row
    return {
        "id": persona_id,
        "name": name,
        "role": role,
        "scheduled_time": scheduled_time,
        "availability_duration": availability_duration,
    }


async def _get_case_snapshot(client, access_code: str | None = None, case_id: str | None = None):
    query = """
        select id, case_name, initial_brief, simulation_duration, common_information, access_code
        from cases
    """
    params = ()
    if case_id:
        query += " where id = ?"
        params = (case_id,)
    elif access_code:
        query += " where upper(access_code) = upper(?)"
        params = (access_code,)
    else:
        query += " limit 1"
    row = await client.execute(query, params)
    if not row.rows:
        raise HTTPException(status_code=404, detail="No case found.")
    (
        case_id,
        case_name,
        initial_brief,
        simulation_duration,
        common_information,
        resolved_access_code,
    ) = row.rows[0]
    return {
        "id": case_id,
        "case_name": case_name,
        "initial_brief": initial_brief,
        "simulation_duration": simulation_duration,
        "common_information": common_information,
        "access_code": resolved_access_code,
    }


async def _get_root_personas(client, case_id):
    rows = await client.execute(
        """
        select p.id, p.name, p.role, p.scheduled_time, p.availability_duration
        from personas p
        where p.case_id = ?
          and p.id not in (
            select referred_persona_id
            from persona_referrals
            where case_id = ?
          )
        order by p.name
        """,
        (case_id, case_id),
    )
    return [_format_persona_row(row) for row in rows.rows]


async def _get_persona_details(client, persona_id):
    row = await client.execute(
        """
        select name, role, known_facts, unknown_facts, hidden_facts, personality_traits
        from personas
        where id = ?
        """,
        (persona_id,),
    )
    if not row.rows:
        raise HTTPException(status_code=404, detail="Persona not found.")
    name, role, known, unknown, hidden, traits = row.rows[0]
    files = await client.execute(
        """
        select f.id, f.bucket, f.object_key, f.file_name, f.content_type,
               pf.share_conditions, pf.perceived_contents
        from persona_files pf
        left join files f on f.id = pf.file_id
        where pf.persona_id = ?
        """,
        (persona_id,),
    )
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
        ) in files.rows
    ]
    return {
        "name": name,
        "role": role,
        "known_facts": known,
        "unknown_facts": unknown,
        "hidden_facts": hidden,
        "personality_traits": traits,
        "files": file_entries,
    }


async def _get_referrals_for_parent(client, case_id, parent_persona_id):
    rows = await client.execute(
        """
        select pr.referred_persona_id, pr.trigger_type, pr.condition_trigger, pr.time_trigger,
               p.name, p.role, p.scheduled_time, p.availability_duration
        from persona_referrals pr
        join personas p on p.id = pr.referred_persona_id
        where pr.case_id = ? and pr.parent_persona_id = ?
        """,
        (case_id, parent_persona_id),
    )
    referrals = []
    for row in rows.rows:
        (
            referred_persona_id,
            trigger_type,
            condition_trigger,
            time_trigger,
            name,
            role,
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
                    "scheduled_time": scheduled_time,
                    "availability_duration": availability_duration,
                    "is_referred": True,
                },
            }
        )
    return referrals


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


@router.post("/start")
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
    }
    elapsed_minutes = _elapsed_minutes(RUNS[run_id])
    contacts = []
    for persona in root_personas:
        availability = _persona_availability(
            persona,
            persona.get("scheduled_time") or 0,
            elapsed_minutes,
        )
        contacts.append({**persona, **availability, "is_referred": False})
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
    }


@router.get("/{run_id}")
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
        contacts.append({**persona, **availability, "is_referred": False})
    referred = []
    if unlocked_ids:
        rows = await client.execute(
            """
            select id, name, role, scheduled_time, availability_duration
            from personas
            where id in ({})
            """.format(
                ",".join(["?"] * len(unlocked_ids))
            ),
            tuple(unlocked_ids),
        )
        for row in rows.rows:
            persona = _format_persona_row(row)
            available_at = run["unlocked_at"].get(persona["id"], elapsed_minutes)
            availability = _persona_availability(
                persona,
                available_at,
                elapsed_minutes,
            )
            referred.append({**persona, **availability, "is_referred": True})
    contacts = contacts + referred
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
    }


@router.post("/{run_id}/message")
async def send_message(run_id: str, payload: dict):
    run = _get_run(run_id)
    persona_id = payload.get("persona_id")
    user_message = payload.get("message", "").strip()
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
        persona_row = await client.execute(
            """
            select id, name, role, scheduled_time, availability_duration
            from personas
            where id = ?
            """,
            (persona_id,),
        )
        if not persona_row.rows:
            raise HTTPException(status_code=404, detail="Persona not found.")
        persona = _format_persona_row(persona_row.rows[0])
        available_at = run["unlocked_at"].get(persona_id, elapsed_minutes)
        availability = _persona_availability(persona, available_at, elapsed_minutes)
    else:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    if not availability["available"]:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    run["active_persona_id"] = persona_id

    referrals = await _get_referrals_for_parent(client, case_snapshot["id"], persona_id)
    locked_referral_names = [
        ref["persona"]["name"]
        for ref in referrals
        if ref["referred_persona_id"] not in run["unlocked_referred_ids"]
    ]
    persona_details = await _get_persona_details(client, persona_id)
    history = run["history"].setdefault(persona_id, [])
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
    filtered_history = [msg for msg in history if msg.get("role") != "system"]
    sanitized_history = _sanitize_history(filtered_history, locked_referral_names)
    combined_system = f"{structured_instruction}\n\n---\n\n{system_prompt}"
    messages = [
        {"role": "system", "content": combined_system},
        *sanitized_history,
        {"role": "user", "content": user_message},
    ]
    try:
        result = await chat_completion_structured(messages)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="LLM request timed out.") from exc
    assistant_reply = result["reply"]
    history_for_classifier = sanitized_history + [
        {"role": "user", "content": user_message}
    ]

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
                    current_count = _count_user_messages(history) + 1
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
                    newly_unlocked.append(referral["persona"])
        elif referral["trigger_type"] == "time":
            if referral["time_trigger"] and elapsed_minutes >= referral["time_trigger"]:
                run["unlocked_referred_ids"].add(referred_id)
                run["unlocked_at"][referred_id] = elapsed_minutes
                newly_unlocked.append(referral["persona"])
    if settings.sim_debug:
        print("SIM DEBUG: newly_unlocked ->", newly_unlocked)

    if newly_unlocked:
        intro = await generate_contact_introduction(
            persona_details,
            newly_unlocked,
            history_for_classifier[-6:],
        )
        assistant_reply = f"{assistant_reply} {intro}"
    history.append({"role": "user", "content": user_message})
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
        "new_contacts": newly_unlocked,
        "shared_files": shared_files,
    }
