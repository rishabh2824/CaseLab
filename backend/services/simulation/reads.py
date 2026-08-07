from sqlmodel import select
from domain_errors import CaseNotFound
from infra.db_models import Case
from models.cases import CaseStructure, PersonaPayload
from models.runtime import PersonaDetail, PersonaGraph, Referral, CaseSnapshot, Run


# Deliberately fetches the full row (no load_only column projection): the only
# caller, getCaseWithGraph below, always needs `structure` right after. Projecting
# it away would just leave it deferred on the returned Case instance, and reading
# a deferred column outside an awaited ORM call raises MissingGreenlet under the
# async engine -- this bit us once already (see getCaseWithGraph's comment) via a
# second session.get(Case, id) that hit the identity map instead of re-querying.
async def fetchCase(session, *, access_code: str) -> Case | None:
    code = access_code.strip()
    # The `!= ""` / `is_not(None)` clauses are otherwise redundant given `code` here
    # (already stripped, and startSimulation rejects an empty access code before
    # this is ever called) -- they're there so this WHERE clause literally matches
    # idx_cases_access_code_unique's partial predicate. A student hitting this on
    # their very first request is exactly the query that most needs the index
    # rather than a generic-plan seq scan across every case.
    result = await session.exec(
        select(Case).where(
            Case.access_code == code,
            Case.access_code.is_not(None),
            Case.access_code != "",
        )
    )
    return result.first()


def caseSnapshot(case) -> CaseSnapshot:
    return CaseSnapshot(
        id=case.id,
        case_name=case.name,
        brief=case.brief,
        simulation_duration=case.duration,
        common_information=case.common_information,
        access_code=case.access_code,
    )


# startSimulation always seeds run.case_snapshot at creation, so this is a pure
# in-memory read — Run.case_snapshot is a required field, never None.
async def getRunCase(run: Run) -> CaseSnapshot:
    return run.case_snapshot


# Shapes a parsed PersonaPayload into the row format stored in the persona graph. The rename
# availability_minutes (wire/admin-authoring field) -> availability_duration (internal +
# client-facing ContactOut.availability_duration) is deliberate and kept.
def getPersonaDetails(persona: PersonaPayload, *, is_referred: bool = False) -> PersonaDetail:
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
# {personas, referrals, roots} shape the simulation runtime expects (Referral field names
# kept as parent_persona_id/referred_persona_id/condition_trigger — this is an internal
# run-blob cache shape, not the case storage/wire contract, so it's left as-is rather than
# renamed to match). Every persona is stored once, keyed by id, regardless of how many
# referral edges point at it — referral edges hold ids only, never an embedded persona.
def flattenPersonas(structure: CaseStructure) -> PersonaGraph:
    roots = set(structure.roots)
    personas = {
        p.id: getPersonaDetails(p, is_referred=p.id not in roots)
        for p in structure.personas
    }
    root_ids = sorted(roots & personas.keys(), key=lambda pid: personas[pid].name)
    referrals = [
        Referral(
            parent_persona_id=referral.from_id,
            referred_persona_id=referral.to_id,
            condition_trigger=referral.conditions or "",
        )
        for referral in structure.referrals
    ]
    return PersonaGraph(personas=personas, referrals=referrals, roots=root_ids)


# startSimulation's only entry into the DB: fetches the case by access code
# once and derives both the snapshot and the initial persona graph from that
# single row, rather than a getCase() + buildPersonaGraph() pair that each
# issued their own fetchCase — the second of which was a session.get(Case, id)
# identity-map hit against the row this same fetch already produced, so it
# never re-ran the query and never picked up `structure` if the first fetch
# hadn't loaded it.
async def getCaseWithGraph(session, access_code: str) -> tuple[CaseSnapshot, PersonaGraph]:
    case = await fetchCase(session, access_code=access_code)
    if case is None: raise CaseNotFound("No case found.")
    structure = CaseStructure.model_validate(case.structure)
    return caseSnapshot(case), flattenPersonas(structure)


# Persona graph for the current run. Same pure in-memory read as getRunCase —
# startSimulation always seeds run.persona_graph at creation.
async def getPersonaGraph(run: Run) -> PersonaGraph:
    return run.persona_graph


# Referrals authored by a persona. Personas here are raw (never a signed profile-photo
# URL) — hydratePersona (services/simulation/state.py) is the caller's job at the
# point it builds a response, not this module's; reads.py never touches Spaces.
def graphReferrals(graph: PersonaGraph, parent_persona_id: str) -> list[Referral]:
    return [edge for edge in graph.referrals if edge.parent_persona_id == parent_persona_id]


# Persona dicts for a set of already-unlocked referred persona ids. Dict lookup means
# de-duplication is free — same reasoning as graphReferrals above re: raw (unhydrated) personas.
def graphPersonas(graph: PersonaGraph, referred_ids) -> list[PersonaDetail]:
    return [graph.personas[pid] for pid in referred_ids if pid in graph.personas]


# Raw persona for any id in the graph, root or referred — O(1) dict lookup.
def graphPersonaById(graph: PersonaGraph, persona_id: str) -> PersonaDetail | None:
    return graph.personas.get(persona_id)
