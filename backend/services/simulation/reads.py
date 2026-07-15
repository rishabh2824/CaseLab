import asyncio
from fastapi import HTTPException
from Queries.simulation import repository as repo
from services.persona_shapes import photo_ref
from infra.spaces import getUrl


def format_persona_row(row: dict, *, presign: bool = True) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "profile_photo": photo_ref(row, presign=presign),
        "availability_duration": row["availability_duration"],
    }


# Presigned photo URLs expire well inside a run's lifetime (SPACES_PRESIGN_EXPIRY_SECONDS,
# 900s by default, vs. up to 120 minutes for a run) — same reasoning as
# service.shared_file_payload. So the persona graph cached into the run blob (see
# build_persona_graph below) stores each photo as a raw file reference, never a signed URL,
# and this re-derives a fresh URL at read time from that cached reference.
def hydrate_persona(persona: dict) -> dict:
    photo = persona.get("profile_photo")
    if photo is None:
        return persona
    return {**persona, "profile_photo": {**photo, "url": getUrl(photo["object_key"])}}


async def get_case(client, access_code: str | None = None, case_id: str | None = None):
    row = await repo.fetch_case_snapshot(client, access_code=access_code, case_id=case_id)
    if row is None: raise HTTPException(status_code=404, detail="No case found.")
    return {
        "id": row["id"],
        "case_name": row["case_name"],
        "initial_brief": row["initial_brief"],
        "simulation_duration": row["simulation_duration"],
        "common_information": row["common_information"],
        "access_code": row["access_code"],
    }


async def get_run_case(run: dict, client):
    cached = run.get("case_snapshot")
    if cached is not None: return cached
    snapshot = await get_case(client, case_id=run["case_id"])
    run["case_snapshot"] = snapshot
    return snapshot


# Root personas + the full referral graph for a case, fetched once and cached into the run
# blob (run["persona_graph"]) exactly like case_snapshot — see get_run_persona_graph. Both
# are immutable for a run's practical lifetime: a case edit mid-run regenerates persona ids
# and breaks the run's references regardless, so caching this costs nothing that wasn't
# already being lost. Stored with raw (unsigned) photo refs — see hydrate_persona.
async def build_persona_graph(client, case_id: str) -> dict:
    root_rows, referral_rows = await asyncio.gather(
        repo.fetch_root_personas(client, case_id),
        repo.fetch_all_referrals(client, case_id),
    )
    root_personas = [format_persona_row(row, presign=False) for row in root_rows]
    referrals = [
        {
            "parent_persona_id": row["parent_persona_id"],
            "referred_persona_id": row["referred_persona_id"],
            "condition_trigger": row["condition_trigger"] or "",
            "persona": {**format_persona_row(row, presign=False), "is_referred": True},
        }
        for row in referral_rows
    ]
    return {"root_personas": root_personas, "referrals": referrals}


async def get_run_persona_graph(run: dict, client) -> dict:
    cached = run.get("persona_graph")
    if cached is not None: return cached
    graph = await build_persona_graph(client, run["case_id"])
    run["persona_graph"] = graph
    return graph


# Referrals authored by one persona, with a freshly-signed photo URL for the referred
# persona — this can end up directly in a live API response (a newly unlocked contact),
# unlike most of the graph, which callers only hydrate where they actually need a URL.
def graph_referrals_for(graph: dict, parent_persona_id: str) -> list[dict]:
    return [
        {**edge, "persona": hydrate_persona(edge["persona"])}
        for edge in graph["referrals"]
        if edge["parent_persona_id"] == parent_persona_id
    ]


# Persona dicts for a set of already-unlocked referred persona ids, de-duplicated by id (a
# persona referred by more than one parent only needs one entry). Hydrated (live/presigned
# photo URL) by default since this usually feeds a contacts list the frontend renders an
# avatar from; pass hydrate=False where the photo is never read (e.g. export_simulation).
def graph_referred_personas(graph: dict, referred_ids, *, hydrate: bool = True) -> list[dict]:
    seen = set()
    personas = []
    for edge in graph["referrals"]:
        pid = edge["referred_persona_id"]
        if pid in referred_ids and pid not in seen:
            seen.add(pid)
            persona = hydrate_persona(edge["persona"]) if hydrate else edge["persona"]
            personas.append(persona)
    return personas


# Raw (unsigned) persona dict for any id in the graph, root or referred — used where the
# caller only needs fields like availability_duration, not a photo URL.
def graph_persona_by_id(graph: dict, persona_id: str) -> dict | None:
    for persona in graph["root_personas"]:
        if persona["id"] == persona_id:
            return persona
    for edge in graph["referrals"]:
        if edge["referred_persona_id"] == persona_id:
            return edge["persona"]
    return None


async def get_persona_details(client, persona_id):
    persona, files = await asyncio.gather(
        repo.fetch_persona_core(client, persona_id),
        repo.fetch_persona_files(client, persona_id),
    )
    if persona is None: raise HTTPException(status_code=404, detail="Persona not found.")
    file_entries = [
        {
            "file_id": row["id"],
            "bucket": row["bucket"],
            "object_key": row["object_key"],
            "file_name": row["file_name"],
            "content_type": row["content_type"],
            "share_conditions": row["share_conditions"],
            "perceived_contents": row["perceived_contents"],
        }
        for row in files
    ]
    return {
        "name": persona["name"],
        "role": persona["role"],
        "profile_photo": photo_ref(persona, presign=True),
        "known_facts": persona["known_facts"],
        "personality_traits": persona["personality_traits"],
        "files": file_entries,
    }
