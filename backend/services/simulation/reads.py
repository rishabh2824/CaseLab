from sqlmodel import select
from domain_errors import CaseNotFound
from infra.db import get_session
from infra.db_models import Case
from infra.spaces import getUrl
from models.cases import CaseStructure, FileEntry, PersonaOut


async def fetchCase(session, *, case_id: int | None = None, access_code: str | None = None) -> Case | None:
    if case_id:
        return await session.get(Case, case_id)
    if access_code:
        result = await session.exec(select(Case).where(Case.access_code == access_code.strip()))
        return result.first()
    raise ValueError("fetch_case requires case_id or access_code.")


# The persona graph cached into the run blob stores each photo as a raw file reference, never a signed URL.
# This re-derives a fresh URL at read time from that cached reference.
def hydratePersona(persona: dict) -> dict:
    photo = persona.get("profile_photo")
    if photo is None:
        return persona
    return {**persona, "profile_photo": {**photo, "url": getUrl(photo["object_key"])}}


def case_snapshot(case) -> dict:
    return {
        "id": case.id,
        "case_name": case.name,
        "initial_brief": case.brief,
        "simulation_duration": case.duration,
        "common_information": case.common_information,
        "access_code": case.access_code,
    }


async def getCase(session, access_code: str | None = None, case_id: int | None = None):
    case = await fetchCase(session, access_code=access_code, case_id=case_id)
    if case is None: raise CaseNotFound("No case found.")
    return case_snapshot(case)


# startSimulation always seeds run["case_snapshot"] at creation, so this only ever opens
# a session on the (effectively unreachable today) cold-cache path — callers don't need
# to hold one open themselves for what's normally a pure in-memory read.
async def getRunCase(run: dict):
    cached = run.get("case_snapshot")
    if cached is not None: return cached
    async with get_session() as session:
        snapshot = await getCase(session, case_id=run["case_id"])
    run["case_snapshot"] = snapshot
    return snapshot


def fileEntry(entry: FileEntry) -> dict:
    file_ref = entry.file
    return {
        "file_id": file_ref.file_id if file_ref else None,
        "object_key": file_ref.object_key if file_ref else None,
        "file_name": file_ref.file_name if file_ref else None,
        "content_type": file_ref.content_type if file_ref else None,
        "share_conditions": entry.share_conditions,
        "perceived_contents": entry.perceived_contents,
    }


# Shapes a parsed PersonaOut into the row format stored in the persona graph
def getPersonaDetails(persona: PersonaOut, *, is_referred: bool = False) -> dict:
    row = {
        "id": persona.id,
        "name": persona.name,
        "role": persona.role,
        "profile_photo": persona.profile_photo.model_dump() if persona.profile_photo else None,
        "availability_duration": persona.availability_minutes,
        "known_facts": persona.known_facts,
        "personality_traits": persona.personality_traits,
        "files": [fileEntry(f) for f in persona.files],
    }
    if is_referred:
        row["is_referred"] = True
    return row


# Reshapes the case's already-flat, parsed CaseStructure into the
# {root_personas, referrals} shape the simulation runtime expects (field names
# kept as parent_persona_id/referred_persona_id/condition_trigger — this is an
# internal run-blob cache shape, not the case storage/wire contract, so it's
# left as-is rather than renamed to match).
def flattenPersonas(structure: CaseStructure) -> tuple[list[dict], list[dict]]:
    personas_by_id = {p.id: p for p in structure.personas}
    roots = set(structure.roots)
    root_rows = sorted(
        (getPersonaDetails(p) for p in personas_by_id.values() if p.id in roots),
        key=lambda p: p["name"],
    )
    edges = [
        {
            "parent_persona_id": referral.from_id,
            "referred_persona_id": referral.to_id,
            "condition_trigger": referral.conditions or "",
            "persona": getPersonaDetails(personas_by_id[referral.to_id], is_referred=True),
        }
        for referral in structure.referrals
    ]
    return root_rows, edges


# Root personas + the full referral graph for a case, fetched once and cached into the run blob
async def buildPersonaGraph(session, case_id: int) -> dict:
    case = await fetchCase(session, case_id=case_id)
    if case is None: raise CaseNotFound("No case found.")
    structure = CaseStructure.model_validate(case.structure)
    root_personas, referrals = flattenPersonas(structure)
    return {"root_personas": root_personas, "referrals": referrals}


# Persona graph for the current run. Same cold-cache-only session pattern as getRunCase —
# startSimulation always seeds run["persona_graph"] at creation.
async def getPersonaGraph(run: dict) -> dict:
    cached = run.get("persona_graph")
    if cached is not None:
        return cached
    async with get_session() as session:
        graph = await buildPersonaGraph(session, run["case_id"])
    run["persona_graph"] = graph
    return graph


# Referrals authored by a persona
def graphReferrals(graph: dict, parent_persona_id: str) -> list[dict]:
    return [
        {**edge, "persona": hydratePersona(edge["persona"])}
        for edge in graph["referrals"]
        if edge["parent_persona_id"] == parent_persona_id
    ]


# Persona dicts for a set of already-unlocked referred persona ids, de-duplicated by id
def graphPersonas(graph: dict, referred_ids, *, hydrate: bool = True) -> list[dict]:
    seen = set()
    personas = []
    for edge in graph["referrals"]:
        pid = edge["referred_persona_id"]
        if pid in referred_ids and pid not in seen:
            seen.add(pid)
            persona = hydratePersona(edge["persona"]) if hydrate else edge["persona"]
            personas.append(persona)
    return personas


# Raw persona dict for any id in the graph, root or referred
def graphPersonaById(graph: dict, persona_id: str) -> dict | None:
    for persona in graph["root_personas"]:
        if persona["id"] == persona_id:
            return persona
    for edge in graph["referrals"]:
        if edge["referred_persona_id"] == persona_id:
            return edge["persona"]
    return None

