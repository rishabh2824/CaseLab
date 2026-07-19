from fastapi import HTTPException
from sqlmodel import select
from infra.db_models import Case
from infra.spaces import getUrl


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
    if case is None: raise HTTPException(status_code=404, detail="No case found.")
    return case_snapshot(case)


async def getRunCase(run: dict, session):
    cached = run.get("case_snapshot")
    if cached is not None: return cached
    snapshot = await getCase(session, case_id=run["case_id"])
    run["case_snapshot"] = snapshot
    return snapshot


def fileEntry(entry: dict) -> dict:
    file_ref = entry.get("file") or {}
    return {
        "file_id": file_ref.get("file_id"),
        "bucket": file_ref.get("bucket"),
        "object_key": file_ref.get("object_key"),
        "file_name": file_ref.get("file_name"),
        "content_type": file_ref.get("content_type"),
        "share_conditions": entry.get("share_conditions"),
        "perceived_contents": entry.get("perceived_contents"),
    }


# Shapes a raw persona dict into the row format stored in the persona graph
def getPersonaDetails(persona: dict, *, is_referred: bool = False) -> dict:
    row = {
        "id": persona["id"],
        "name": persona.get("name") or "",
        "role": persona.get("role") or "",
        "profile_photo": persona.get("profile_photo"),
        "availability_duration": persona.get("availability_minutes"),
        "known_facts": persona.get("known_facts"),
        "personality_traits": persona.get("personality_traits"),
        "files": [fileEntry(f) for f in persona.get("files") or []],
    }
    if is_referred:
        row["is_referred"] = True
    return row


# Walk the case's JSONB persona tree once into the flat {root_personas, referrals} shape
def flattenPersonas(personas: list[dict]) -> tuple[list[dict], list[dict]]:
    root_rows = sorted((getPersonaDetails(p) for p in personas), key=lambda p: p["name"])
    edges: list[dict] = []

    def walk(parent_id: str, referrals: list[dict]) -> None:
        for referral in referrals:
            child = referral["persona"]
            edges.append(
                {
                    "parent_persona_id": parent_id,
                    "referred_persona_id": child["id"],
                    "condition_trigger": referral.get("conditions") or "",
                    "persona": getPersonaDetails(child, is_referred=True),
                }
            )
            walk(child["id"], child.get("referrals") or [])

    for persona in personas:
        walk(persona["id"], persona.get("referrals") or [])

    return root_rows, edges


# Root personas + the full referral graph for a case, fetched once and cached into the run blob
async def buildPersonaGraph(session, case_id: int) -> dict:
    case = await fetchCase(session, case_id=case_id)
    if case is None: raise HTTPException(status_code=404, detail="No case found.")
    root_personas, referrals = flattenPersonas(case.structure.get("personas") or [])
    return {"root_personas": root_personas, "referrals": referrals}


# Persona graph for the current run
async def getPersonaGraph(run: dict, session) -> dict:
    cached = run.get("persona_graph")
    if cached is not None:
        return cached
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

