import time
import uuid
from domain_errors import InvalidRequest
from models.simulations import (
    ChatMessage,
    ContactOut,
    ExportCase,
    ExportPersona,
    ExportResponse,
    RunCase,
    RunState,
    SharedFileOut,
    StartSimulation,
)
from models.runtime import PersonaDetail, Run, FileRecord
from infra.db import getSession
from infra.rate_limit_policy import simulationLimit
from services.simulation.run_store import insertRun, getRun
from services.simulation.reads import getCaseWithGraph, getRunCase, getPersonaGraph, graphPersonas
from services.simulation.turn_state import elapsedMinutes, formatHistory, getChatState, personaAvailability
from infra.spaces import getUrl


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


# Turns an internal file record into client facing shape
def toSharedFileOut(info: FileRecord) -> SharedFileOut:
    return SharedFileOut(
        file_id=info.file_id,
        file_name=info.file_name,
        content_type=info.content_type,
        url=getUrl(info.object_key),
    )


async def startSimulation(payload: StartSimulation) -> RunState:
    access_code = payload.access_code.strip()
    if not access_code:
        raise InvalidRequest("Access code is required.")
    await simulationLimit(access_code)
    async with getSession() as session:
        case_snapshot, persona_graph = await getCaseWithGraph(session, access_code)
    if not persona_graph.roots:
        raise InvalidRequest("No root personas found.")
    root_personas = [hydratePersona(persona_graph.personas[pid]) for pid in persona_graph.roots]
    run_id = uuid.uuid4().hex
    run = Run(
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
    return RunState(
        run_id=run_id,
        case=RunCase(
            id=case_snapshot.id,
            case_name=case_snapshot.case_name,
            brief=case_snapshot.brief,
            simulation_duration=case_snapshot.simulation_duration,
        ),
        contacts=contacts,
        active_persona_id=run.active_persona_id,
        shared_files=[],
        histories={},
    )


async def getSimulationState(run_id: str) -> RunState:
    run = await getRun(run_id)
    case_snapshot = await getRunCase(run)
    graph = await getPersonaGraph(run)
    root_personas = [hydratePersona(graph.personas[pid]) for pid in graph.roots]
    unlocked_ids = run.unlocked_referred_ids
    elapsed = elapsedMinutes(run)
    referred_personas = [hydratePersona(p) for p in graphPersonas(graph, unlocked_ids)]
    contacts = buildContacts(run, root_personas, elapsed, referred_personas)
    visible_persona_ids = {persona.id for persona in contacts}
    return RunState(
        run_id=run_id,
        case=RunCase(
            id=case_snapshot.id,
            case_name=case_snapshot.case_name,
            brief=case_snapshot.brief,
            simulation_duration=case_snapshot.simulation_duration,
        ),
        contacts=contacts,
        active_persona_id=run.active_persona_id,
        shared_files=[toSharedFileOut(info) for info in run.shared_files.values()],
        histories=formatHistory(run, visible_persona_ids),
    )


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
        case=ExportCase(id=case_snapshot.id, case_name=case_snapshot.case_name),
        personas=[
            ExportPersona(
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
