import asyncio
import json
import time
import uuid
from fastapi import HTTPException
from models.simulations import NotesPayload, SendMessagePayload, StartSimulationPayload
from infra.db import get_session
from infra.llm import classifyHarassment, personaReplyStream
from infra.rate_limit import messageLimit, simulationLimit
from services.simulation.run_store import cleanupRuns, insertRun, getRun, updateRun
from services.simulation.prompt import (replyInstructions, systemPrompt, cleanReply, coerceHandles, parseReply, fileShare, referralUnlock, sanitizeHistory)
from services.simulation.reply_stream import ReplyExtractor
from services.simulation.reads import (buildPersonaGraph, getCase, getRunCase, getPersonaGraph, graphPersonaById, graphReferrals, graphPersonas, hydratePersona)
from services.simulation.turn_state import (NONSENSE_THRESHOLD, boundaryReply, chatStatePayload, shapeChatState, elapsedMinutes, formatHistory, getChatState, persona_availability, editChatState)
from infra.spaces import getUrl


HISTORY_MESSAGE_LIMIT = 6
DECISION_JUDGE_HISTORY_LIMIT = 8
MESSAGE_WORDS = 50
NOTES_CHARS = 20000
GENERATION_TIMEOUT = 120 # Wall-clock cap on a single reply stream.


# One Server-Sent Event as a sse-starlette dict; the response class handles the wire framing
def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


# One contact-list entry: persona fields + computed availability + chat state.
def buildContact(run, persona, available_at_minutes, elapsed_minutes, *, is_referred):
    availability = persona_availability(persona, available_at_minutes, elapsed_minutes)
    contact = {**persona, **availability, "is_referred": is_referred, **chatStatePayload(run, persona["id"])}
    # Each file's share_conditions/perceived_contents are the unlock secret/answer key —
    # fine for internal judging (resolve_turn_decisions), never for the browser. The
    # frontend contact list doesn't use `files` at all; drop it rather than trim it.
    contact.pop("files", None)
    return contact


# Full contacts list: every root persona, plus every unlocked referred persona. Both lists are expected pre-hydrated
def buildContacts(run, root_personas, elapsed_minutes, referred_personas=None):
    contacts = [
        buildContact(run, persona, 0, elapsed_minutes, is_referred=False)
        for persona in root_personas
    ]
    for persona in referred_personas or []:
        available_at = run["unlocked_at"].get(persona["id"], elapsed_minutes)
        contacts.append(buildContact(run, persona, available_at, elapsed_minutes, is_referred=True))
    return contacts


async def startSimulation(payload: StartSimulationPayload):
    access_code = payload.access_code.strip()
    if not access_code:
        raise HTTPException(status_code=400, detail="Access code is required.")
    await simulationLimit(access_code)
    async with get_session() as session:
        case_snapshot = await getCase(session, access_code=access_code)
        persona_graph = await buildPersonaGraph(session, case_snapshot["id"])
    if not persona_graph["root_personas"]:
        raise HTTPException(status_code=400, detail="No root personas found.")
    root_personas = [hydratePersona(p) for p in persona_graph["root_personas"]]
    run_id = uuid.uuid4().hex
    run = {
        "case_id": case_snapshot["id"],
        "case_snapshot": case_snapshot,
        "persona_graph": persona_graph,
        "start_time": time.time(),
        "active_persona_id": root_personas[0]["id"],
        "unlocked_referred_ids": set(),
        "unlocked_at": {},
        "shared_files": {},
        "history": {},
        "persona_chat_state": {},
        "notes": "",
    }
    elapsed = elapsedMinutes(run)
    contacts = buildContacts(run, root_personas, elapsed)
    active_candidates = [c for c in contacts if c["available"]]
    if active_candidates:
        run["active_persona_id"] = active_candidates[0]["id"]
    await insertRun(run_id, run)
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


async def getSimulationState(run_id: str):
    run = await getRun(run_id)
    async with get_session() as session:
        case_snapshot = await getRunCase(run, session)
        graph = await getPersonaGraph(run, session)
    root_personas = [hydratePersona(p) for p in graph["root_personas"]]
    unlocked_ids = run["unlocked_referred_ids"]
    elapsed = elapsedMinutes(run)
    referred_personas = graphPersonas(graph, unlocked_ids)
    contacts = buildContacts(run, root_personas, elapsed, referred_personas)
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
        "shared_files": [file(info) for info in run["shared_files"].values()],
        "histories": formatHistory(run, visible_persona_ids),
        "notes": run.get("notes", "")
    }


async def updateNotes(run_id: str, payload: NotesPayload) -> dict:
    if len(payload.notes) > NOTES_CHARS:
        raise HTTPException(
            status_code=400, detail=f"Notes are too long ({NOTES_CHARS} characters max)."
        )

    def set_notes(run):
        run["notes"] = payload.notes
        return run["notes"]

    notes = await updateRun(run_id, set_notes)
    return {"notes": notes}


async def exportSimulation(run_id: str):
    run = await getRun(run_id)
    async with get_session() as session:
        case_snapshot = await getRunCase(run, session)
        graph = await getPersonaGraph(run, session)
    unlocked_ids = run["unlocked_referred_ids"]
    personas = [{**persona, "is_referred": False} for persona in graph["root_personas"]]

    if unlocked_ids:
        referred_personas = graphPersonas(graph, unlocked_ids, hydrate=False)
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
async def resolveDecisions(persona_id, decision_history, run) -> dict:
    graph = run["persona_graph"]
    referrals = graphReferrals(graph, persona_id)
    persona_details = graphPersonaById(graph, persona_id)
    if persona_details is None:
        raise HTTPException(status_code=404, detail="Persona not found.")
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
        asyncio.gather(*(referralUnlock(referral, judge_history) for referral in pending_referrals)),
        asyncio.gather(*(fileShare(file_entry, judge_history) for file_entry in pending_files)),
    )
    return {
        "referrals": referrals,
        "persona_details": persona_details,
        "pending_referrals": pending_referrals,
        "pending_files": pending_files,
        "referral_results": referral_results,
        "file_results": file_results,
    }


# Prepares the message for final response generation
async def message(run_id: str, payload: SendMessagePayload) -> dict:
    run = await getRun(run_id)
    await messageLimit(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise HTTPException(status_code=400, detail="persona_id and message are required.")
    if len(user_message.split()) > MESSAGE_WORDS:
        raise HTTPException(
            status_code=400,
            detail=f"Message is too long ({MESSAGE_WORDS} words max). Please shorten it and try again.",
        )
    elapsed = elapsedMinutes(run)
    async with get_session() as session:
        case_snapshot = await getRunCase(run, session)
        graph = await getPersonaGraph(run, session)
    simulation_duration = case_snapshot.get("simulation_duration")
    if simulation_duration and elapsed >= simulation_duration:
        raise HTTPException(status_code=400, detail="This simulation has ended.")
    root_map = {p["id"]: p for p in graph["root_personas"]}
    if persona_id in root_map:
        availability = persona_availability(root_map[persona_id], 0, elapsed)
    elif persona_id in run["unlocked_referred_ids"]:
        persona = graphPersonaById(graph, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="Persona not found.")
        available_at = run["unlocked_at"].get(persona_id, elapsed)
        availability = persona_availability(persona, available_at, elapsed)
    else:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    if not availability["available"]:
        raise HTTPException(status_code=400, detail="Persona is not available yet.")
    def start_turn(r):
        if getChatState(r, persona_id)["ended"]:
            raise HTTPException(status_code=400, detail="This conversation has ended.")
        r["active_persona_id"] = persona_id
        turns = r["history"].setdefault(persona_id, [])
        turns.append({"role": "user", "content": user_message})
        return turns

    history = await updateRun(run_id, start_turn)
    decision_history = [msg for msg in history if msg.get("role") != "system"]

    try:
        message_label, decisions = await asyncio.gather(
            classifyHarassment(user_message, decision_history),
            resolveDecisions(persona_id, decision_history, run),
        )
    except Exception:
        raise HTTPException(status_code=502, detail="Something went wrong. Please resend your message.")
    persona_details = decisions["persona_details"]

    if message_label != "normal":
        def flag_and_append(r):
            state = editChatState(r, persona_id)
            state["last_flag_type"] = message_label
            state["warning_count"] += 1
            if state["warning_count"] >= NONSENSE_THRESHOLD:
                state["ended"] = True
                state["end_reason"] = message_label
            reply = boundaryReply(persona_details["name"], state["ended"])
            history = appendToTurn(r, persona_id, reply)
            return state, reply, history

        chat_state, assistant_reply, boundary_history = await updateRun(
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
                **shapeChatState(chat_state),
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

    stable_prompt, turn_prompt = systemPrompt(
        case_snapshot,
        persona_details,
        forbidden_referral_names=forbidden_referral_names,
        eligible_referrals=eligible_referrals,
        eligible_files=eligible_files,
        withheld_file_names=withheld_file_names,
    )
    reply_instruction = replyInstructions()

    sanitized_history = sanitizeHistory(decision_history, forbidden_referral_names)
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


# Turns an internal file record into client facing shape
def file(info: dict) -> dict:
    return {
        "file_id": info["file_id"],
        "file_name": info["file_name"],
        "content_type": info["content_type"],
        "url": getUrl(info["object_key"]),
    }


# Applies the decisions received from the LLM
async def applyDecisions(run_id, prepared, unlock_handles, share_handles, persona_id, reply):
    referral_handles = prepared["referral_handles"]
    file_handles = prepared["file_handles"]

    def applyAppend(run):
        elapsed = elapsedMinutes(run)
        new_contacts = []
        for handle in dict.fromkeys(unlock_handles):  # de-dupe, preserve order
            referral = referral_handles.get(handle)
            if referral is None:
                continue
            referred_id = referral["referred_persona_id"]
            if referred_id in run["unlocked_referred_ids"]:
                continue
            run["unlocked_referred_ids"].add(referred_id)
            run["unlocked_at"][referred_id] = elapsed
            new_contacts.append(
                {**referral["persona"], **chatStatePayload(run, referred_id)}
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
            shared_files.append(file(shared_info))

        history = appendToTurn(run, persona_id, reply)
        chat_state = chatStatePayload(run, persona_id)
        return new_contacts, shared_files, history, chat_state

    return await updateRun(run_id, applyAppend)


# Append {"role": "assistant", "content": reply} to the persona's history list and return that persona's formatted history
def appendToTurn(run, persona_id, reply):
    run["history"].setdefault(persona_id, []).append(
        {"role": "assistant", "content": reply}
    )
    return formatHistory(run, {persona_id}).get(persona_id, [])


# Strong references to in-flight generations, just a set so asyncio doesn't garbage-collect a task mid-flight
# Entries remove themselves via add_done_callback once finished.
generations: set[asyncio.Task] = set()


# Takes the cleaned response from the LLM and saves it to DB.
async def reply(prepared: dict, queue: asyncio.Queue) -> None:
    run_id = prepared["run_id"]
    persona_id = prepared["persona_id"]
    extractor = ReplyExtractor()
    raw_parts: list[str] = []

    def emit(event: str, data: dict) -> None:
        queue.put_nowait(sse(event, data))

    try:
        # No fallback here (unlike classifyHarassment's silent "normal" default) —
        # a reply that fails to generate/stream has nothing safe to fall back to,
        # so the message fails and the user is asked to resend it.
        try:
            async with asyncio.timeout(GENERATION_TIMEOUT):
                async for text in personaReplyStream(prepared["system"], prepared["messages"]):
                    raw_parts.append(text)
                    delta = extractor.feed(text)
                    if delta:
                        emit("delta", {"text": delta})
        except Exception:
            emit("error", {"detail": "The reply could not be generated. Please resend your message."})
            return

        # Authoritative parse of the full raw text — the streamed deltas are a
        # best-effort preview; this is the reply of record for persistence + done.
        envelope = parseReply("".join(raw_parts))
        reply = cleanReply(str(envelope.get("reply") or "")) if envelope else ""
        if not reply:
            emit("error", {"detail": "The reply could not be generated. Please resend your message."})
            return

        unlock_handles = coerceHandles(envelope.get("introduce"))
        share_handles = coerceHandles(envelope.get("send_files"))

        try:
            new_contacts, shared_files, history, chat_state_payload = await applyDecisions(
                run_id, prepared, unlock_handles, share_handles, persona_id, reply
            )
        except Exception:
            emit("error", {"detail": "The reply could not be saved. Please try again."})
            return

        if not extractor.found_reply:
            # The incremental lexer never surfaced the reply text (an unparseable
            # stream, or `reply` absent from the streamed view) — emit it once now,
            # matching the old single-delta behavior. A lexer bug can degrade the
            # live preview but never lose the reply, which is the authoritative
            # value parsed above.
            emit("delta", {"text": reply})

        emit("meta", {"new_contacts": new_contacts, "shared_files": shared_files, **chat_state_payload})
        emit("done", {"reply": reply, "history": history})
    finally:
        queue.put_nowait(None)  # sentinel: tell the consumer the stream is complete


# Sends the final response to frontend
async def streamMessage(prepared: dict):
    if prepared["kind"] == "boundary":
        # reply/history are already fully computed and persisted in
        # prepare_message's _flag_and_append mutate — nothing left to write
        # here, just yield the already-known values.
        yield sse("meta", prepared["meta"])
        boundary_reply = prepared["reply"]
        if boundary_reply:
            yield sse("delta", {"text": boundary_reply})
        yield sse("done", {"reply": boundary_reply, "history": prepared["history"]})
        return

    # --- normal: the producer runs as a task this generator does not own, and
    # streams SSE frames through `queue`. sse-starlette cancels this generator's
    # whole task group the instant the client disconnects (e.g. a page reload);
    # because the producer is a separate, referenced task, that cancellation
    # reaches only our `queue.get()` here — the producer keeps running and
    # persists the reply regardless of whether anyone is still listening.
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(reply(prepared, queue))
    generations.add(task)
    task.add_done_callback(generations.discard)

    while True:
        try:
            item = await queue.get()
        except asyncio.CancelledError:
            return  # client disconnected — producer is unaffected and persists in the background
        if item is None:
            return  # producer signalled completion
        yield item
