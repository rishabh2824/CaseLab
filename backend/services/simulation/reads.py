from sqlmodel import select
from domain_errors import CaseNotFound
from infra.db_models import Case
from models.cases import CaseStructure, PersonaOut
from models.simulation_runtime import PersonaDetail, PersonaGraph, Referral, RunCaseSnapshot, Run


async def fetchCase(session, *, case_id: int | None = None, access_code: str | None = None) -> Case | None:
    if case_id:
        return await session.get(Case, case_id)
    if access_code:
        result = await session.exec(select(Case).where(Case.access_code == access_code.strip()))
        return result.first()
    raise ValueError("fetch_case requires case_id or access_code.")


def caseSnapshot(case) -> RunCaseSnapshot:
    return RunCaseSnapshot(
        id=case.id,
        case_name=case.name,
        initial_brief=case.brief,
        simulation_duration=case.duration,
        common_information=case.common_information,
        access_code=case.access_code,
    )


async def getCase(session, access_code: str | None = None, case_id: int | None = None) -> RunCaseSnapshot:
    case = await fetchCase(session, access_code=access_code, case_id=case_id)
    if case is None: raise CaseNotFound("No case found.")
    return caseSnapshot(case)


# startSimulation always seeds run.case_snapshot at creation, so this is a pure
# in-memory read — Run.case_snapshot is a required field, never None.
async def getRunCase(run: Run) -> RunCaseSnapshot:
    return run.case_snapshot


# Shapes a parsed PersonaOut into the row format stored in the persona graph. The rename
# availability_minutes (wire/admin-authoring field) -> availability_duration (internal +
# client-facing ContactOut.availability_duration) is deliberate and kept.
def getPersonaDetails(persona: PersonaOut, *, is_referred: bool = False) -> PersonaDetail:
    return PersonaDetail(
        id=persona.id,
        name=persona.name,
        role=persona.role,
        profile_photo=persona.profile_photo,
        availability_duration=persona.availability_minutes,
        known_facts=persona.known_facts,
        personality_traits=persona.personality_traits,
        files=persona.files,
        is_referred=is_referred,
    )


# Reshapes the case's already-flat, parsed CaseStructure into the PersonaGraph
# {root_personas, referrals} shape the simulation runtime expects (field names
# kept as parent_persona_id/referred_persona_id/condition_trigger — this is an
# internal run-blob cache shape, not the case storage/wire contract, so it's
# left as-is rather than renamed to match).
def flattenPersonas(structure: CaseStructure) -> tuple[list[PersonaDetail], list[Referral]]:
    personas_by_id = {p.id: p for p in structure.personas}
    roots = set(structure.roots)
    root_rows = sorted(
        (getPersonaDetails(p) for p in personas_by_id.values() if p.id in roots),
        key=lambda p: p.name,
    )
    edges = [
        Referral(
            parent_persona_id=referral.from_id,
            referred_persona_id=referral.to_id,
            condition_trigger=referral.conditions or "",
            persona=getPersonaDetails(personas_by_id[referral.to_id], is_referred=True),
        )
        for referral in structure.referrals
    ]
    return root_rows, edges


# Root personas + the full referral graph for a case, fetched once and cached into the run blob
async def buildPersonaGraph(session, case_id: int) -> PersonaGraph:
    case = await fetchCase(session, case_id=case_id)
    if case is None: raise CaseNotFound("No case found.")
    structure = CaseStructure.model_validate(case.structure)
    root_personas, referrals = flattenPersonas(structure)
    return PersonaGraph(root_personas=root_personas, referrals=referrals)


# Persona graph for the current run. Same pure in-memory read as getRunCase —
# startSimulation always seeds run.persona_graph at creation.
async def getPersonaGraph(run: Run) -> PersonaGraph:
    return run.persona_graph


# Referrals authored by a persona. Personas here are raw (never a signed profile-photo
# URL) — hydratePersona (services/simulation/service.py) is the caller's job at the
# point it builds a response, not this module's; reads.py never touches Spaces.
def graphReferrals(graph: PersonaGraph, parent_persona_id: str) -> list[Referral]:
    return [edge for edge in graph.referrals if edge.parent_persona_id == parent_persona_id]


# Persona dicts for a set of already-unlocked referred persona ids, de-duplicated by id.
# Raw personas, same reasoning as graphReferrals above.
def graphPersonas(graph: PersonaGraph, referred_ids) -> list[PersonaDetail]:
    seen = set()
    personas = []
    for edge in graph.referrals:
        pid = edge.referred_persona_id
        if pid in referred_ids and pid not in seen:
            seen.add(pid)
            personas.append(edge.persona)
    return personas


# Raw persona for any id in the graph, root or referred
def graphPersonaById(graph: PersonaGraph, persona_id: str) -> PersonaDetail | None:
    for persona in graph.root_personas:
        if persona.id == persona_id:
            return persona
    for edge in graph.referrals:
        if edge.referred_persona_id == persona_id:
            return edge.persona
    return None

