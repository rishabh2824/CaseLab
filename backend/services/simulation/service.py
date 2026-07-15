import asyncio
import json
import time
import uuid
from fastapi import HTTPException
from models.simulations import NotesPayload, SendMessagePayload, StartSimulationPayload
from infra.db import getDb
from infra.llm import classifyHarassment, personaReply
from infra.rate_limit import messageLimit, simulationLimit
from Queries.simulation.runs import run_store
from services.simulation.prompt import (
    reply_instructions,
    build_system_prompt,
    clean_reply,
    coerce_handles,
    parse_reply,
    resolve_file_share,
    resolve_referral_unlock,
    sanitize_history,
)
from services.simulation.reads import (
    build_persona_graph,
    get_case,
    get_persona_details,
    get_run_case,
    get_run_persona_graph,
    graph_persona_by_id,
    graph_referrals_for,
    graph_referred_personas,
    hydrate_persona,
)
from services.simulation.turn_state import (
    NONSENSE_END_THRESHOLD,
    _build_boundary_reply,
    _chat_state_payload,
    _chat_state_payload_from_state,
    _elapsed_minutes,
    _format_run_histories,
    _get_persona_chat_state,
    persona_availability,
    _persona_chat_state_ref,
)
from infra.spaces import getUrl

HISTORY_MESSAGE_LIMIT = 6
DECISION_JUDGE_HISTORY_LIMIT = 8
MAX_USER_MESSAGE_WORDS = 50
MAX_NOTES_CHARS = 20000

#One Server-Sent Event as a sse-starlette dict; the response class handles the wire framing
def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


#One contact-list entry: persona fields + computed availability + chat state.
def build_contact(run, persona, available_at_minutes, elapsed_minutes, *, is_referred):
    availability = persona_availability(persona, available_at_minutes, elapsed_minutes)
    return {**persona, **availability, "is_referred": is_referred, **_chat_state_payload(run, persona["id"])}


# Full contacts list: every root persona, plus every unlocked referred persona. Both lists
# are expected pre-hydrated (live/presigned photo URLs) — see hydrate_persona.
def build_contacts(run, root_personas, elapsed_minutes, referred_personas=None):
    contacts = [
        build_contact(run, persona, 0, elapsed_minutes, is_referred=False)
        for persona in root_personas
    ]
    for persona in referred_personas or []:
        available_at = run["unlocked_at"].get(persona["id"], elapsed_minutes)
        contacts.append(build_contact(run, persona, available_at, elapsed_minutes, is_referred=True))
    return contacts


async def start_simulation(payload: StartSimulationPayload):
    client = getDb()
    access_code = payload.access_code.strip()
    if not access_code:
        raise HTTPException(status_code=400, detail="Access code is required.")
    await simulationLimit(access_code)
    case_snapshot = await get_case(client, access_code=access_code)
    persona_graph = await build_persona_graph(client, case_snapshot["id"])
    if not persona_graph["root_personas"]:
        raise HTTPException(status_code=400, detail="No root personas found.")
    root_personas = [hydrate_persona(p) for p in persona_graph["root_personas"]]
    run_id = uuid.uuid4().hex
    run = {
        "case_id": case_snapshot["id"],
        "case_snapshot": case_snapshot,  # cached for the life of the run
        "persona_graph": persona_graph,  # cached for the life of the run — see reads.py
        "start_time": time.time(),
        "active_persona_id": root_personas[0]["id"],
        "unlocked_referred_ids": set(),
        "unlocked_at": {},
        "shared_files": {},
        "history": {},
        "persona_chat_state": {},
        "notes": "",
    }
    elapsed_minutes = _elapsed_minutes(run)
    contacts = build_contacts(run, root_personas, elapsed_minutes)
    active_candidates = [c for c in contacts if c["available"]]
    if active_candidates:
        run["active_persona_id"] = active_candidates[0]["id"]
    await run_store.put(run_id, run)
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
        "notes": run["notes"],
    }


async def get_simulation_state(run_id: str):
    run = await run_store.get(run_id)
    client = getDb()
    case_snapshot = await get_run_case(run, client)
    graph = await get_run_persona_graph(run, client)
    root_personas = [hydrate_persona(p) for p in graph["root_personas"]]
    unlocked_ids = run["unlocked_referred_ids"]
    elapsed_minutes = _elapsed_minutes(run)
    referred_personas = graph_referred_personas(graph, unlocked_ids)
    contacts = build_contacts(run, root_personas, elapsed_minutes, referred_personas)
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
        "shared_files": [shared_file_payload(info) for info in run["shared_files"].values()],
        "histories": _format_run_histories(run, visible_persona_ids),
        "notes": run.get("notes", "")
    }


async def update_notes(run_id: str, payload: NotesPayload) -> dict:
    if len(payload.notes) > MAX_NOTES_CHARS:
        raise HTTPException(
            status_code=400, detail=f"Notes are too long ({MAX_NOTES_CHARS} characters max)."
        )

    def _set_notes(run):
        run["notes"] = payload.notes
        return run["notes"]

    notes = await run_store.mutate(run_id, _set_notes)
    return {"notes": notes}


async def export_simulation(run_id: str):
    run = await run_store.get(run_id)
    client = getDb()
    case_snapshot = await get_run_case(run, client)
    graph = await get_run_persona_graph(run, client)
    unlocked_ids = run["unlocked_referred_ids"]
    # No photo in the export output below, so the raw (unsigned) graph entries are used
    # directly here — no need to hydrate a URL nobody reads.
    personas = [{**persona, "is_referred": False} for persona in graph["root_personas"]]

    if unlocked_ids:
        referred_personas = graph_referred_personas(graph, unlocked_ids, hydrate=False)
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


# Fetch the persona's referrals + details and resolve every unlock/share eligibility for this turn
async def resolve_turn_decisions(client, persona_id, decision_history, run) -> dict:
    # Referrals come straight out of the run's cached persona graph (no DB call) — see
    # reads.get_run_persona_graph, populated earlier in prepare_message. persona_details
    # (known_facts, personality_traits, files) isn't part of that cache yet — still fetched
    # fresh, since it wasn't in scope for this pass.
    referrals = graph_referrals_for(run["persona_graph"], persona_id)
    persona_details = await get_persona_details(client, persona_id)
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
    judge_history = decision_history[-DECISION_JUDGE_HISTORY_LIMIT:]
    referral_results, file_results = await asyncio.gather(
        asyncio.gather(*(resolve_referral_unlock(referral, judge_history) for referral in pending_referrals)),
        asyncio.gather(*(resolve_file_share(file_entry, judge_history) for file_entry in pending_files)),
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
    run = await run_store.get(run_id)
    await messageLimit(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise HTTPException(status_code=400, detail="persona_id and message are required.")
    if len(user_message.split()) > MAX_USER_MESSAGE_WORDS:
        raise HTTPException(
            status_code=400,
            detail=f"Message is too long ({MAX_USER_MESSAGE_WORDS} words max). Please shorten it and try again.",
        )
    elapsed_minutes = _elapsed_minutes(run)
    client = getDb()
    case_snapshot = await get_run_case(run, client)
    simulation_duration = case_snapshot.get("simulation_duration")
    if simulation_duration and elapsed_minutes >= simulation_duration:
        raise HTTPException(status_code=400, detail="This simulation has ended.")
    graph = await get_run_persona_graph(run, client)
    root_map = {p["id"]: p for p in graph["root_personas"]}
    if persona_id in root_map:
        availability = persona_availability(root_map[persona_id], 0, elapsed_minutes)
    elif persona_id in run["unlocked_referred_ids"]:
        persona = graph_persona_by_id(graph, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="Persona not found.")
        available_at = run["unlocked_at"].get(persona_id, elapsed_minutes)
        availability = persona_availability(persona, available_at, elapsed_minutes)
    else:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    if not availability["available"]:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    def start_turn(r):
        if _get_persona_chat_state(r, persona_id)["ended"]:
            raise HTTPException(status_code=400, detail="This conversation has ended.")
        r["active_persona_id"] = persona_id
        turns = r["history"].setdefault(persona_id, [])
        turns.append({"role": "user", "content": user_message})
        return turns

    history = await run_store.mutate(run_id, start_turn)
    decision_history = [msg for msg in history if msg.get("role") != "system"]

    try:
        message_label, decisions = await asyncio.gather(
            classifyHarassment(user_message, decision_history),
            resolve_turn_decisions(client, persona_id, decision_history, run),
        )
    except Exception:
        # No fallback here (unlike classifyHarassment's silent "normal" default) —
        # a referral/file-eligibility judge failing after retries means we can't
        # safely decide what the persona is allowed to reveal this turn, so the
        # whole message fails rather than guessing.
        raise HTTPException(
            status_code=502, detail="Something went wrong. Please resend your message."
        )
    persona_details = decisions["persona_details"]

    if message_label != "normal":
        def flag_and_append(r):
            state = _persona_chat_state_ref(r, persona_id)
            state["last_flag_type"] = message_label
            state["warning_count"] += 1
            if state["warning_count"] >= NONSENSE_END_THRESHOLD:
                state["ended"] = True
                state["end_reason"] = message_label
            reply = _build_boundary_reply(persona_details["name"], state["ended"])
            history = append_assistant_turn(r, persona_id, reply)
            return state, reply, history

        chat_state, assistant_reply, boundary_history = await run_store.mutate(
            run_id, flag_and_append
        )
        return {
            "kind": "boundary",
            "run_id": run_id,
            "persona_id": persona_id,
            "reply": assistant_reply,
            "history": boundary_history,
            "meta": {
                "new_contacts": [],
                "shared_files": [],
                **_chat_state_payload_from_state(chat_state),
            },
        }

    pending_referrals = decisions["pending_referrals"]
    pending_files = decisions["pending_files"]
    referral_results = decisions["referral_results"]
    file_results = decisions["file_results"]

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

    eligible_files = []
    file_handles = {}
    for file_entry, is_eligible in zip(pending_files, file_results):
        if is_eligible:
            handle = f"F{len(eligible_files) + 1}"
            eligible_files.append(
                {
                    "handle": handle,
                    "name": file_entry.get("file_name") or "file",
                    "perceived_contents": file_entry.get("perceived_contents"),
                }
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

    stable_prompt, turn_prompt = build_system_prompt(
        case_snapshot,
        persona_details,
        forbidden_referral_names=forbidden_referral_names,
        eligible_referrals=eligible_referrals,
        eligible_files=eligible_files,
        withheld_file_names=withheld_file_names,
    )
    reply_instruction = reply_instructions()

    sanitized_history = sanitize_history(decision_history, forbidden_referral_names)
    recent_history = sanitized_history[-HISTORY_MESSAGE_LIMIT:]

    cached_prompt = f"{reply_instruction}\n\n---\n\n{stable_prompt}"
    system = [
        {
            "type": "text",
            "text": cached_prompt,
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        },
        {"type": "text", "text": turn_prompt},
    ]

    return {
        "kind": "normal",
        "run_id": run_id,
        "persona_id": persona_id,
        "system": system,
        "messages": recent_history,
        "referral_handles": referral_handles,
        "file_handles": file_handles,
    }


"""Re-sign a previously-shared file's download URL from its stored
    object_key. Presigned URLs expire (SPACES_PRESIGN_EXPIRY_SECONDS, 900s by
    default) well before a run's ~2-hour lifetime, so the URL must be generated
    fresh on every read rather than cached at share time — caching it made
    links start 403ing partway through a still-active simulation."""
def shared_file_payload(info: dict) -> dict:
    return {
        "file_id": info["file_id"],
        "file_name": info["file_name"],
        "content_type": info["content_type"],
        "url": getUrl(info["object_key"]),
    }


async def apply_reply_decisions(run_id, prepared, unlock_handles, share_handles, persona_id, reply):
    referral_handles = prepared["referral_handles"]
    file_handles = prepared["file_handles"]

    def _apply_and_append(run):
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
            shared_files.append(shared_file_payload(shared_info))

        history = append_assistant_turn(run, persona_id, reply)
        chat_state_payload = _chat_state_payload(run, persona_id)
        return new_contacts, shared_files, history, chat_state_payload

    return await run_store.mutate(run_id, _apply_and_append)


# Append the assistant reply to a persona's history and return that persona's formatted history
def append_assistant_turn(run, persona_id, reply):
    """. Call INSIDE a run_store.mutate callback."""
    run["history"].setdefault(persona_id, []).append(
        {"role": "assistant", "content": reply}
    )
    return _format_run_histories(run, {persona_id}).get(persona_id, [])


# Strong references to in-flight generations, keyed by nothing in particular —
# just a set so asyncio doesn't garbage-collect a task mid-flight (a bare
# create_task() result with no other referent is only weakly held by the loop).
# Entries remove themselves via add_done_callback once finished.
_in_flight_generations: set[asyncio.Task] = set()


async def _generate_and_persist_reply(prepared: dict) -> dict:
    """The actual LLM call + persistence for a 'normal' reply turn, run as a
    detached, shielded task (see stream_message) so that a client disconnecting
    mid-generation — e.g. reloading the page while waiting for a reply — can
    no longer cancel the generation or lose the reply. It always runs to
    completion and is saved to the run; a client that reconnects picks it up
    through the next GET /{run_id} poll or the live WebSocket push.
    """
    run_id = prepared["run_id"]
    persona_id = prepared["persona_id"]

    # No fallback here (unlike classifyHarassment's silent "normal" default) —
    # a reply that fails to generate after retries has nothing safe to fall
    # back to, so the message fails and the user is asked to resend it.
    try:
        raw = await personaReply(prepared["system"], prepared["messages"])
    except Exception:
        return {"kind": "error", "detail": "The reply could not be generated. Please resend your message."}

    envelope = parse_reply(raw)
    reply = clean_reply(str(envelope.get("reply") or "")) if envelope else ""
    if not reply:
        return {"kind": "error", "detail": "The reply could not be generated. Please resend your message."}

    unlock_handles = coerce_handles(envelope.get("introduce"))
    share_handles = coerce_handles(envelope.get("send_files"))

    try:
        new_contacts, shared_files, history, chat_state_payload = await apply_reply_decisions(
            run_id, prepared, unlock_handles, share_handles, persona_id, reply
        )
    except Exception:
        return {"kind": "error", "detail": "The reply could not be saved. Please try again."}

    return {
        "kind": "ok",
        "reply": reply,
        "history": history,
        "meta": {"new_contacts": new_contacts, "shared_files": shared_files, **chat_state_payload},
    }


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
    if prepared["kind"] == "boundary":
        # reply/history are already fully computed and persisted in
        # prepare_message's _flag_and_append mutate — nothing left to write
        # here, just yield the already-known values.
        yield sse("meta", prepared["meta"])
        reply = prepared["reply"]
        if reply:
            yield sse("delta", {"text": reply})
        yield sse("done", {"reply": reply, "history": prepared["history"]})
        return

    # --- normal: run generation+persistence in a task this generator does not
    # own. sse-starlette cancels this generator's whole task group the instant
    # the client disconnects (e.g. a page reload); asyncio.shield stops that
    # cancellation from reaching `task`, so it keeps running and persists the
    # reply regardless of whether anyone is still listening.
    task = asyncio.create_task(_generate_and_persist_reply(prepared))
    _in_flight_generations.add(task)
    task.add_done_callback(_in_flight_generations.discard)

    try:
        result = await asyncio.shield(task)
    except asyncio.CancelledError:
        return  # client disconnected — task is unaffected and persists in the background

    if result["kind"] == "error":
        yield sse("error", {"detail": result["detail"]})
        return

    yield sse("meta", result["meta"])
    yield sse("delta", {"text": result["reply"]})
    yield sse("done", {"reply": result["reply"], "history": result["history"]})
