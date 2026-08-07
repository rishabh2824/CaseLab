import asyncio
from domain_errors import InvalidRequest, NotFoundError, UpstreamError
from models.simulations import ContactOut, SendMessage
from models.runtime import (
    DecisionBundle, BoundaryTurn, NormalTurn, PreparedTurn, Run, FileRecord, TurnMeta,
)
from infra.db import getSession
from infra.llm import classifyHarassment
from infra.rate_limit_policy import messageLimit
from services.simulation.run_store import getRun, updateRun
from services.simulation.prompt import replyInstructions, systemPrompt, fileShare, referralUnlock
from services.simulation.reads import getRunCase, getPersonaGraph, graphPersonaById, graphReferrals
from services.simulation.turn_state import (
    NONSENSE_THRESHOLD, appendMessage, boundaryReply, chatStatePayload, shapeChatState,
    elapsedMinutes, getChatState, personaAvailability, editChatState,
)
from services.simulation.state import hydratePersona, toSharedFileOut


HISTORY_MESSAGE_LIMIT = 6
MESSAGE_WORDS = 50

# Structured like services/cases.py's VERSION_CONFLICT: a {message, code} dict
# so the frontend (run.svelte.ts) can branch on `code` instead of string-matching
# the message.
CONVERSATION_ENDED = {
    "message": "This conversation has ended.",
    "code": "conversation_ended",
}


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


# Validates the turn, runs the safety/unlock/share classifiers, and builds either a
# PreparedNormalTurn (ready for stream.generateReply) or a fully-resolved
# PreparedBoundaryTurn (a flagged message, nothing left to generate).
async def prepareTurn(run_id: str, payload: SendMessage) -> PreparedTurn:
    persona_id = payload.persona_id
    user_message = payload.message.strip()
    if not persona_id or not user_message:
        raise InvalidRequest("persona_id and message are required.")
    if len(user_message.split()) > MESSAGE_WORDS:
        raise InvalidRequest(f"Message is too long ({MESSAGE_WORDS} words max). Please shorten it and try again.")

    def start_turn(r: Run):
        if getChatState(r, persona_id).ended:
            raise InvalidRequest(CONVERSATION_ENDED)
        r.active_persona_id = persona_id
        appendMessage(r, persona_id, "user", user_message)
        return r.history[persona_id]

    # getRun, messageLimit, and updateRun(start_turn) share one session/transaction instead
    # of each opening (and committing/rolling back) their own — three round trips of
    # transaction overhead collapse into one. Safe to do because nothing between them
    # awaits anything external (just in-memory validation on the already-fetched `run`), so
    # the connection is never held open across slow I/O like the LLM call later in this flow.
    # persona_ids=set() on getRun: every check below reads case_snapshot/persona_graph/
    # unlocked_referred_ids/unlocked_at/shared_files off `run`, never `run.history` —
    # loading it here would be pure dead work, since start_turn re-reads the row (with its
    # own fresh, persona-scoped history) via its own with_for_update() select anyway.
    async with getSession() as session:
        run = await getRun(run_id, persona_ids=set(), session=session)
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

        # Every check above is in-memory/cached-read only and can reject the request
        # outright — only pay for the rate-limit write once a message could plausibly
        # succeed. It commits on its own (see messageLimit), so a student is charged for
        # this attempt even if start_turn below then fails (e.g. the run just expired) —
        # kept as-is deliberately since it's the simpler behavior and rate limiting a
        # student out of a case is already vanishingly rare in practice.
        await messageLimit(run_id, session=session)

        history = await updateRun(run_id, start_turn, persona_ids={persona_id}, session=session)

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
            return state, reply

        chat_state, assistant_reply = await updateRun(
            run_id, flag_and_append, persona_ids={persona_id}
        )
        return BoundaryTurn(
            run_id=run_id,
            persona_id=persona_id,
            reply=assistant_reply,
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

    case_prompt = systemPrompt(
        case_snapshot,
        persona_details,
        forbidden_referral_names=forbidden_referral_names,
        eligible_referrals=eligible_referrals,
        eligible_files=eligible_files,
    )
    reply_instruction = replyInstructions()
    recent_history = decision_history[-HISTORY_MESSAGE_LIMIT:]

    system_message = {
        "role": "system",
        "content": f"{reply_instruction}\n\n---\n\n{case_prompt}",
    }

    return NormalTurn(
        run_id=run_id,
        persona_id=persona_id,
        messages=[system_message, *recent_history],
        referral_handles=referral_handles,
        file_handles=file_handles,
    )


# Applies the decisions received from the LLM: persists the reply, any newly-unlocked
# referrals, and any newly-shared files as one updateRun transaction.
async def applyDecisions(run_id, prepared: NormalTurn, unlock_handles, share_handles, persona_id, reply):
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
            shared_info = FileRecord(
                file_id=file_id,
                file_name=file_entry.file.file_name or "file",
                content_type=file_entry.file.content_type,
                object_key=file_entry.file.object_key,
            )
            run.shared_files[file_id] = shared_info
            shared_files.append(toSharedFileOut(shared_info))

        appendMessage(run, persona_id, "assistant", reply)
        chat_state = chatStatePayload(run, persona_id)
        return new_contacts, shared_files, chat_state

    # applyAppend never reads run.history for persona_id — elapsedMinutes, the unlock
    # loop, the file loop, and chatStatePayload only touch start_time,
    # unlocked_referred_ids, unlocked_at, shared_files, persona_graph, and
    # persona_chat_state, and appendMessage only writes (setdefault(...).append(...)).
    # persona_ids=set() skips loading + hydrating every prior message for this persona.
    return await updateRun(run_id, applyAppend, persona_ids=set())
