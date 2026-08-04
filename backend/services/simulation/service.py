import asyncio
import time
import uuid
from pydantic import BaseModel
from domain_errors import InvalidRequest, NotFoundError, UpstreamError
from models.simulations import (
    ChatMessage,
    ContactOut,
    ExportCaseSummary,
    ExportPersonaOut,
    ExportResponse,
    NotesPayload,
    NotesResponse,
    RunCaseSummary,
    RunStateResponse,
    SendMessagePayload,
    SharedFileOut,
    StartSimulationPayload,
)
from models.simulation_runtime import (
    DecisionBundle, DeltaFrame, DoneFrame, ErrorFrame, PersonaDetail, PreparedBoundaryTurn, PreparedNormalTurn,
    PreparedTurn, Run, SharedFileRecord, TurnMeta,
)
from infra.db import getSession
from infra.llm import classifyHarassment, personaReplyStream
from infra.rate_limit import messageLimit, simulationLimit
from services.simulation.run_store import insertRun, getRun, updateRun
from services.simulation.prompt import (replyInstructions, systemPrompt, cleanReply, coerceHandles, parseReply, fileShare, referralUnlock, sanitizeHistory)
from services.simulation.reply_stream import ReplyExtractor
from services.simulation.reads import (buildPersonaGraph, getCase, getRunCase, getPersonaGraph, graphPersonaById, graphReferrals, graphPersonas)
from services.simulation.turn_state import (NONSENSE_THRESHOLD, appendMessage, boundaryReply, chatStatePayload, shapeChatState, elapsedMinutes, formatHistory, getChatState, personaAvailability, editChatState)
from infra.spaces import getUrl


HISTORY_MESSAGE_LIMIT = 6
MESSAGE_WORDS = 50
NOTES_CHARS = 20000
GENERATION_TIMEOUT = 120 # Wall-clock cap on a single reply stream.

# Structured like services/cases.py's VERSION_CONFLICT: a {message, code} dict
# so the frontend (run.svelte.ts) can branch on `code` instead of string-matching
# the message.
CONVERSATION_ENDED = {
    "message": "This conversation has ended.",
    "code": "conversation_ended",
}


# One Server-Sent Event as a sse-starlette dict; the response class handles the wire framing
def sse(event: str, data: BaseModel) -> dict:
    return {"event": event, "data": data.model_dump_json()}


# The persona graph cached into the run blob stores each photo as a raw file reference, never a signed URL.
# This re-derives a fresh URL at read time from that cached reference. Runs outside any
# updateRun transaction on freshly-read (non-transactional) data, so model_copy() (rather
# than in-place mutation) is the correct, sanctioned tool here — it must not appear inside
# any updateRun closure. Lives here (not reads.py) because signing a URL is this service's
# response-building job, not reads.py's persona-graph shaping.
def hydratePersona(persona: PersonaDetail) -> PersonaDetail:
    if persona.profile_photo is None:
        return persona
    return persona.model_copy(update={"profile_photo_url": getUrl(persona.profile_photo.object_key)})


# Full contacts list: every root persona, plus every unlocked referred persona. Both lists are expected pre-hydrated
def buildContacts(
    run: Run, root_personas: list[PersonaDetail], elapsed_minutes: int,
    referred_personas: list[PersonaDetail] | None = None,
) -> list[ContactOut]:
    contacts = [
        ContactOut.from_persona_detail(
            persona, is_referred=False, chat_state=getChatState(run, persona.id),
            **personaAvailability(persona, 0, elapsed_minutes),
        )
        for persona in root_personas
    ]
    for persona in referred_personas or []:
        available_at = run.unlocked_at.get(persona.id, elapsed_minutes)
        contacts.append(
            ContactOut.from_persona_detail(
                persona, is_referred=True, chat_state=getChatState(run, persona.id),
                **personaAvailability(persona, available_at, elapsed_minutes),
            )
        )
    return contacts


async def startSimulation(payload: StartSimulationPayload) -> RunStateResponse:
    access_code = payload.access_code.strip()
    if not access_code:
        raise InvalidRequest("Access code is required.")
    await simulationLimit(access_code)
    async with getSession() as session:
        case_snapshot = await getCase(session, access_code=access_code)
        persona_graph = await buildPersonaGraph(session, case_snapshot.id)
    if not persona_graph.roots:
        raise InvalidRequest("No root personas found.")
    root_personas = [hydratePersona(persona_graph.personas[pid]) for pid in persona_graph.roots]
    run_id = uuid.uuid4().hex
    run = Run(
        case_id=case_snapshot.id,
        case_snapshot=case_snapshot,
        persona_graph=persona_graph,
        start_time=time.time(),
        active_persona_id=root_personas[0].id,
    )
    elapsed = elapsedMinutes(run)
    contacts = buildContacts(run, root_personas, elapsed)
    active_candidates = [c for c in contacts if c.available]
    if active_candidates:
        run.active_persona_id = active_candidates[0].id
    await insertRun(run_id, run)
    return RunStateResponse(
        run_id=run_id,
        case=RunCaseSummary(
            id=case_snapshot.id,
            case_name=case_snapshot.case_name,
            brief=case_snapshot.brief,
            simulation_duration=case_snapshot.simulation_duration,
        ),
        contacts=contacts,
        active_persona_id=run.active_persona_id,
        shared_files=[],
        histories={},
        notes=run.notes,
    )


async def getSimulationState(run_id: str) -> RunStateResponse:
    run = await getRun(run_id)
    case_snapshot = await getRunCase(run)
    graph = await getPersonaGraph(run)
    root_personas = [hydratePersona(graph.personas[pid]) for pid in graph.roots]
    unlocked_ids = run.unlocked_referred_ids
    elapsed = elapsedMinutes(run)
    referred_personas = [hydratePersona(p) for p in graphPersonas(graph, unlocked_ids)]
    contacts = buildContacts(run, root_personas, elapsed, referred_personas)
    visible_persona_ids = {persona.id for persona in contacts}
    return RunStateResponse(
        run_id=run_id,
        case=RunCaseSummary(
            id=case_snapshot.id,
            case_name=case_snapshot.case_name,
            brief=case_snapshot.brief,
            simulation_duration=case_snapshot.simulation_duration,
        ),
        contacts=contacts,
        active_persona_id=run.active_persona_id,
        shared_files=[toSharedFileOut(info) for info in run.shared_files.values()],
        histories=formatHistory(run, visible_persona_ids),
        notes=run.notes,
    )


async def updateNotes(run_id: str, payload: NotesPayload) -> NotesResponse:
    if len(payload.notes) > NOTES_CHARS:
        raise InvalidRequest(f"Notes are too long ({NOTES_CHARS} characters max).")

    def set_notes(run: Run):
        run.notes = payload.notes
        return run.notes

    notes = await updateRun(run_id, set_notes)
    return NotesResponse(notes=notes)


async def exportSimulation(run_id: str) -> ExportResponse:
    run = await getRun(run_id)
    case_snapshot = await getRunCase(run)
    graph = await getPersonaGraph(run)
    unlocked_ids = run.unlocked_referred_ids
    # is_referred is already False on every root persona (PersonaDetail's default,
    # set by getPersonaDetails) — no need to force it the way the old dict-spread did
    # when the key could simply be absent.
    personas = [graph.personas[pid] for pid in graph.roots]

    if unlocked_ids:
        referred_personas = graphPersonas(graph, unlocked_ids)
        referred_personas.sort(
            key=lambda persona: run.unlocked_at.get(persona.id, 0)
        )
        personas.extend(referred_personas)

    return ExportResponse(
        case=ExportCaseSummary(id=case_snapshot.id, case_name=case_snapshot.case_name),
        personas=[
            ExportPersonaOut(
                id=persona.id,
                name=persona.name,
                role=persona.role,
                messages=[
                    ChatMessage(role=message.role, content=message.content)
                    for message in run.history.get(persona.id, [])
                    if message.role in {"user", "assistant"}
                ],
            )
            for persona in personas
        ],
    )


# Fetch the persona's referrals + details and resolve every unlock/share eligibility for this turn
async def resolveDecisions(persona_id, decision_history, run: Run) -> DecisionBundle:
    graph = run.persona_graph
    referrals = graphReferrals(graph, persona_id)
    persona_details = graphPersonaById(graph, persona_id)
    if persona_details is None:
        raise NotFoundError("Persona not found.")
    pending_referrals = [
        referral
        for referral in referrals
        if referral.referred_persona_id not in run.unlocked_referred_ids
    ]
    pending_files = [
        file_entry
        for file_entry in persona_details.files
        if file_entry.file and file_entry.file.file_id and file_entry.file.file_id not in run.shared_files
    ]
    # decision_history is passed through unsliced — formatTranscript (infra/llm.py) applies
    # the shared CLASSIFIER_HISTORY_LIMIT window itself, same as classifyHarassment.
    referral_results, file_results = await asyncio.gather(
        asyncio.gather(*(referralUnlock(referral, decision_history) for referral in pending_referrals)),
        asyncio.gather(*(fileShare(file_entry, decision_history) for file_entry in pending_files)),
    )
    return DecisionBundle(
        referrals=referrals,
        persona_details=persona_details,
        pending_referrals=pending_referrals,
        pending_files=pending_files,
        referral_results=referral_results,
        file_results=file_results,
    )


# Prepares the message for final response generation
async def message(run_id: str, payload: SendMessagePayload) -> PreparedTurn:
    run = await getRun(run_id)
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise InvalidRequest("persona_id and message are required.")
    if len(user_message.split()) > MESSAGE_WORDS:
        raise InvalidRequest(f"Message is too long ({MESSAGE_WORDS} words max). Please shorten it and try again.")
    elapsed = elapsedMinutes(run)
    case_snapshot = await getRunCase(run)
    graph = await getPersonaGraph(run)
    simulation_duration = case_snapshot.simulation_duration
    if simulation_duration and elapsed >= simulation_duration:
        raise InvalidRequest("This simulation has ended.")
    if persona_id in graph.roots:
        availability = personaAvailability(graph.personas[persona_id], 0, elapsed)
    elif persona_id in run.unlocked_referred_ids:
        persona = graphPersonaById(graph, persona_id)
        if persona is None:
            raise NotFoundError("Persona not found.")
        available_at = run.unlocked_at.get(persona_id, elapsed)
        availability = personaAvailability(persona, available_at, elapsed)
    else:
        raise InvalidRequest("Persona is not available yet.")
    if not availability["available"]:
        raise InvalidRequest("Persona is not available yet.")

    # Every check above is in-memory/cached-read only and can reject the request outright —
    # only pay for the rate-limit DB write once a message could plausibly succeed.
    await messageLimit(run_id)

    def start_turn(r: Run):
        if getChatState(r, persona_id).ended:
            raise InvalidRequest(CONVERSATION_ENDED)
        r.active_persona_id = persona_id
        appendMessage(r, persona_id, "user", user_message)
        return r.history[persona_id]

    history = await updateRun(run_id, start_turn)
    # Downstream (prompt.py, infra/llm.py) still speaks plain {"role","content"} dicts —
    # that layer is untyped by design (it formats/classifies untrusted LLM-facing text,
    # not our own internal state) — so convert back to dicts at this boundary.
    decision_history = [{"role": msg.role, "content": msg.content} for msg in history]

    try:
        message_label, decisions = await asyncio.gather(
            classifyHarassment(user_message, decision_history),
            resolveDecisions(persona_id, decision_history, run),
        )
    except Exception as exc:
        raise UpstreamError("Something went wrong. Please resend your message.") from exc
    persona_details = decisions.persona_details

    if message_label != "normal":
        def flag_and_append(r: Run):
            state = editChatState(r, persona_id)
            state.last_flag_type = message_label
            state.warning_count += 1
            if state.warning_count >= NONSENSE_THRESHOLD:
                state.ended = True
                state.end_reason = message_label
            reply = boundaryReply(persona_details.name, state.ended)
            appendMessage(r, persona_id, "assistant", reply)
            history = formatHistory(r, {persona_id}).get(persona_id, [])
            return state, reply, history

        chat_state, assistant_reply, boundary_history = await updateRun(
            run_id, flag_and_append
        )
        return PreparedBoundaryTurn(
            run_id=run_id,
            persona_id=persona_id,
            reply=assistant_reply,
            history=boundary_history,
            meta=TurnMeta(
                new_contacts=[],
                shared_files=[],
                **shapeChatState(chat_state),
            ),
        )

    pending_referrals = decisions.pending_referrals
    pending_files = decisions.pending_files
    referral_results = decisions.referral_results
    file_results = decisions.file_results

    eligible_referrals = []
    forbidden_referral_names = []
    referral_handles = {}
    for referral, is_eligible in zip(pending_referrals, referral_results):
        if is_eligible:
            handle = f"R{len(eligible_referrals) + 1}"
            persona = graph.personas[referral.referred_persona_id]
            eligible_referrals.append(
                {"handle": handle, "name": persona.name, "role": persona.role}
            )
            referral_handles[handle] = referral
        else:
            forbidden_referral_names.append(graph.personas[referral.referred_persona_id].name)

    eligible_files = []
    file_handles = {}
    for file_entry, is_eligible in zip(pending_files, file_results):
        if is_eligible:
            handle = f"F{len(eligible_files) + 1}"
            eligible_files.append(
                {
                    "handle": handle,
                    "name": (file_entry.file.file_name if file_entry.file else None) or "file",
                    "perceived_contents": file_entry.perceived_contents,
                }
            )
            file_handles[handle] = file_entry
    eligible_file_ids = {fe.file.file_id for fe in file_handles.values() if fe.file}
    withheld_file_names = [
        (file_entry.file.file_name if file_entry.file else None) or "a file"
        for file_entry in persona_details.files
        if not (file_entry.file and file_entry.file.file_id)
        or (
            file_entry.file.file_id not in run.shared_files
            and file_entry.file.file_id not in eligible_file_ids
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
    system_message = {
        "role": "system",
        "content": [
            {
                "type": "text",
                "text": cached_prompt,
                "cache_control": {"type": "ephemeral", "ttl": "1h"},
            },
            {"type": "text", "text": turn_prompt},
        ],
    }

    return PreparedNormalTurn(
        run_id=run_id,
        persona_id=persona_id,
        messages=[system_message, *recent_history],
        referral_handles=referral_handles,
        file_handles=file_handles,
    )


# Turns an internal file record into client facing shape
def toSharedFileOut(info: SharedFileRecord) -> SharedFileOut:
    return SharedFileOut(
        file_id=info.file_id,
        file_name=info.file_name,
        content_type=info.content_type,
        url=getUrl(info.object_key),
    )


# Applies the decisions received from the LLM
async def applyDecisions(run_id, prepared: PreparedNormalTurn, unlock_handles, share_handles, persona_id, reply):
    referral_handles = prepared.referral_handles
    file_handles = prepared.file_handles

    def applyAppend(run: Run):
        elapsed = elapsedMinutes(run)
        new_contacts = []
        for handle in dict.fromkeys(unlock_handles):  # de-dupe, preserve order
            referral = referral_handles.get(handle)
            if referral is None:
                continue
            referred_id = referral.referred_persona_id
            if referred_id in run.unlocked_referred_ids:
                continue
            run.unlocked_referred_ids.add(referred_id)
            run.unlocked_at[referred_id] = elapsed
            # The graph's persona copy is raw (graphReferrals/resolveDecisions never
            # hydrates — see reads.py), so it's hydrated here, at the point this response
            # is built. Compute real availability — a newly-unlocked referred persona can
            # itself have a bounded availability_duration.
            referred_persona = run.persona_graph.personas[referred_id]
            contact = ContactOut.from_persona_detail(
                hydratePersona(referred_persona), is_referred=True, chat_state=getChatState(run, referred_id),
                **personaAvailability(referred_persona, elapsed, elapsed),
            )
            new_contacts.append(contact)

        shared_files = []
        for handle in dict.fromkeys(share_handles):
            file_entry = file_handles.get(handle)
            if file_entry is None or file_entry.file is None:
                continue
            file_id = file_entry.file.file_id
            if not file_id or file_id in run.shared_files:
                continue
            shared_info = SharedFileRecord(
                file_id=file_id,
                file_name=file_entry.file.file_name or "file",
                content_type=file_entry.file.content_type,
                object_key=file_entry.file.object_key,
            )
            run.shared_files[file_id] = shared_info
            shared_files.append(toSharedFileOut(shared_info))

        appendMessage(run, persona_id, "assistant", reply)
        history = formatHistory(run, {persona_id}).get(persona_id, [])
        chat_state = chatStatePayload(run, persona_id)
        return new_contacts, shared_files, history, chat_state

    return await updateRun(run_id, applyAppend)


# Strong references to in-flight generations, just a set so asyncio doesn't garbage-collect a task mid-flight
# Entries remove themselves via add_done_callback once finished.
generations: set[asyncio.Task] = set()


# Takes the cleaned response from the LLM and saves it to DB.
async def reply(prepared: PreparedNormalTurn, queue: asyncio.Queue) -> None:
    run_id = prepared.run_id
    persona_id = prepared.persona_id
    extractor = ReplyExtractor()
    raw_parts: list[str] = []

    def emit(event: str, data: BaseModel) -> None:
        queue.put_nowait(sse(event, data))

    try:
        # No fallback here (unlike classifyHarassment's silent "normal" default) —
        # a reply that fails to generate/stream has nothing safe to fall back to,
        # so the message fails and the user is asked to resend it.
        try:
            async with asyncio.timeout(GENERATION_TIMEOUT):
                async for event in personaReplyStream(prepared.messages):
                    if event["type"] == "delta":
                        raw_parts.append(event["text"])
                        delta = extractor.feed(event["text"])
                        if delta:
                            emit("delta", DeltaFrame(text=delta))
        except Exception:
            emit("error", ErrorFrame(detail="The reply could not be generated. Please resend your message."))
            return

        # Authoritative parse of the full raw text — the streamed deltas are a
        # best-effort preview; this is the reply of record for persistence + done.
        envelope = parseReply("".join(raw_parts))
        reply = cleanReply(str(envelope.get("reply") or "")) if envelope else ""
        if not reply:
            emit("error", ErrorFrame(detail="The reply could not be generated. Please resend your message."))
            return

        unlock_handles = coerceHandles(envelope.get("introduce"))
        share_handles = coerceHandles(envelope.get("send_files"))

        try:
            new_contacts, shared_files, history, chat_state = await applyDecisions(
                run_id, prepared, unlock_handles, share_handles, persona_id, reply
            )
        except Exception:
            emit("error", ErrorFrame(detail="The reply could not be saved. Please try again."))
            return

        if not extractor.found_reply:
            # The incremental lexer never surfaced the reply text (an unparseable
            # stream, or `reply` absent from the streamed view) — emit it once now,
            # matching the old single-delta behavior. A lexer bug can degrade the
            # live preview but never lose the reply, which is the authoritative
            # value parsed above.
            emit("delta", DeltaFrame(text=reply))

        emit("meta", TurnMeta(new_contacts=new_contacts, shared_files=shared_files, **chat_state))
        emit("done", DoneFrame(reply=reply, history=history))
    finally:
        queue.put_nowait(None)  # sentinel: tell the consumer the stream is complete


# Sends the final response to frontend
async def streamMessage(prepared: PreparedTurn):
    if isinstance(prepared, PreparedBoundaryTurn):
        # reply/history are already fully computed and persisted in
        # prepare_message's _flag_and_append mutate — nothing left to write
        # here, just yield the already-known values.
        yield sse("meta", prepared.meta)
        boundary_reply = prepared.reply
        if boundary_reply:
            yield sse("delta", DeltaFrame(text=boundary_reply))
        yield sse("done", DoneFrame(reply=boundary_reply, history=prepared.history))
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
