"""services/simulation/reads.py — pure shaping of persona-graph data.

`getUrl` is the only impure seam these functions touch; it's monkeypatched on
the `reads` module directly (not via the `sim` fixture, which owns a
different, higher-level set of tests).
"""

from __future__ import annotations

from types import SimpleNamespace

from models.cases import FileEntry, FileRef, PersonaOut
from services.simulation import reads as reads_module

from tests import factories


def signedUrl(object_key: str) -> str:
    return f"https://spaces.test/{object_key}?signed=1"


# --------------------------------------------------------------------------
# hydratePersona
# --------------------------------------------------------------------------


def test_hydrate_persona_resigns_the_photo(monkeypatch):
    monkeypatch.setattr(reads_module, "getUrl", signedUrl)
    persona = {
        "id": "A",
        "profile_photo": {"object_key": "cases/1/photo.png", "file_name": "photo.png", "content_type": "image/png"},
    }
    result = reads_module.hydratePersona(persona)
    assert result["profile_photo"]["url"] == signedUrl("cases/1/photo.png")
    assert result["profile_photo"]["object_key"] == "cases/1/photo.png"  # original fields preserved
    # Input untouched: no "url" key was added to the original photo dict.
    assert "url" not in persona["profile_photo"]


def test_hydrate_persona_returns_persona_untouched_when_no_photo():
    persona = {"id": "A", "profile_photo": None}
    result = reads_module.hydratePersona(persona)
    assert result is persona


def test_hydrate_persona_does_not_mutate_input(monkeypatch):
    monkeypatch.setattr(reads_module, "getUrl", signedUrl)
    photo = {"object_key": "cases/1/photo.png"}
    persona = {"id": "A", "profile_photo": photo}
    reads_module.hydratePersona(persona)
    assert persona["profile_photo"] is photo
    assert "url" not in photo


# --------------------------------------------------------------------------
# caseSnapshot
# --------------------------------------------------------------------------


def test_case_snapshot_shapes_the_case_row():
    case = SimpleNamespace(
        id=1,
        name="Sterling Industries",
        brief="Reduce office supply costs.",
        common_information="Background.",
        duration=45,
        access_code="STERLING",
    )
    assert reads_module.caseSnapshot(case) == {
        "id": 1,
        "case_name": "Sterling Industries",
        "initial_brief": "Reduce office supply costs.",
        "simulation_duration": 45,
        "common_information": "Background.",
        "access_code": "STERLING",
    }


# --------------------------------------------------------------------------
# fileEntry
# --------------------------------------------------------------------------


def test_file_entry_shapes_a_present_file():
    entry = FileEntry(
        file=FileRef(file_id="7", object_key="cases/1/doc.pdf", file_name="doc.pdf", content_type="application/pdf"),
        share_conditions="asks about the budget",
        perceived_contents="last quarter's numbers",
    )
    assert reads_module.fileEntry(entry) == {
        "file_id": "7",
        "object_key": "cases/1/doc.pdf",
        "file_name": "doc.pdf",
        "content_type": "application/pdf",
        "share_conditions": "asks about the budget",
        "perceived_contents": "last quarter's numbers",
    }


def test_file_entry_handles_file_is_none():
    entry = FileEntry(file=None, share_conditions=None, perceived_contents=None)
    assert reads_module.fileEntry(entry) == {
        "file_id": None,
        "object_key": None,
        "file_name": None,
        "content_type": None,
        "share_conditions": None,
        "perceived_contents": None,
    }


# --------------------------------------------------------------------------
# getPersonaDetails
# --------------------------------------------------------------------------


def personaOut(**overrides) -> PersonaOut:
    data = factories.persona(
        "A",
        name="Mary",
        role="CFO",
        known_facts="secret facts",
        personality_traits="calm",
        availability_minutes=30,
        files=[factories.fileEntry()],
    )
    data.update(overrides)
    return PersonaOut.model_validate(data)


def test_get_persona_details_carries_secrets_and_renames_duration_field():
    row = reads_module.getPersonaDetails(personaOut())
    assert row["known_facts"] == "secret facts"
    assert row["personality_traits"] == "calm"
    assert row["availability_duration"] == 30  # availability_minutes -> availability_duration
    assert len(row["files"]) == 1
    assert "is_referred" not in row  # only present when explicitly asked


def test_get_persona_details_is_referred_only_when_asked():
    row = reads_module.getPersonaDetails(personaOut(), is_referred=True)
    assert row["is_referred"] is True


# --------------------------------------------------------------------------
# flattenPersonas
# --------------------------------------------------------------------------


def test_flatten_personas_root_rows_sorted_by_name():
    structure = factories.caseStructure(
        personas=[factories.persona("A", name="Zed"), factories.persona("B", name="Alice")],
        referrals=[],
        roots=["A", "B"],
    )
    root_rows, _ = reads_module.flattenPersonas(structure)
    assert [row["name"] for row in root_rows] == ["Alice", "Zed"]


def test_flatten_personas_every_referral_becomes_an_edge():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B", conditions=None)],
        roots=["A"],
    )
    _, edges = reads_module.flattenPersonas(structure)
    assert len(edges) == 1
    edge = edges[0]
    assert edge["parent_persona_id"] == "A"
    assert edge["referred_persona_id"] == "B"
    assert edge["condition_trigger"] == ""  # None condition becomes ""
    assert edge["persona"]["is_referred"] is True


def test_flatten_personas_persona_referred_by_two_parents_produces_two_edges():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B"), factories.persona("C")],
        referrals=[factories.referral("A", "C"), factories.referral("B", "C")],
        roots=["A", "B"],
    )
    _, edges = reads_module.flattenPersonas(structure)
    targets = [(e["parent_persona_id"], e["referred_persona_id"]) for e in edges]
    assert set(targets) == {("A", "C"), ("B", "C")}


def test_flatten_personas_persona_that_is_both_root_and_referral_target():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B")],
        roots=["A", "B"],
    )
    root_rows, edges = reads_module.flattenPersonas(structure)
    assert {row["id"] for row in root_rows} == {"A", "B"}
    assert edges[0]["referred_persona_id"] == "B"


# --------------------------------------------------------------------------
# graphReferrals / graphPersonas / graphPersonaById
# --------------------------------------------------------------------------


def buildGraph(monkeypatch) -> dict:
    monkeypatch.setattr(reads_module, "getUrl", signedUrl)
    structure = factories.caseStructure(
        personas=[
            factories.persona("A"),
            factories.persona("B"),
            factories.persona(
                "C",
                profile_photo={"object_key": "cases/1/c.png", "file_name": "c.png", "content_type": "image/png"},
            ),
            factories.persona("D"),
        ],
        referrals=[
            factories.referral("A", "C"),
            factories.referral("B", "C"),
            factories.referral("A", "D"),
        ],
        roots=["A", "B"],
    )
    root_rows, edges = reads_module.flattenPersonas(structure)
    return {"root_personas": root_rows, "referrals": edges}


def test_graph_referrals_filters_by_parent_and_hydrates(monkeypatch):
    graph = buildGraph(monkeypatch)
    referrals = reads_module.graphReferrals(graph, "A")
    referred_ids = {edge["referred_persona_id"] for edge in referrals}
    assert referred_ids == {"C", "D"}
    c_edge = next(edge for edge in referrals if edge["referred_persona_id"] == "C")
    assert c_edge["persona"]["profile_photo"]["url"] == signedUrl("cases/1/c.png")


def test_graph_personas_deduplicates_when_two_edges_point_at_the_same_persona(monkeypatch):
    graph = buildGraph(monkeypatch)
    personas = reads_module.graphPersonas(graph, {"C", "D"})
    assert sorted(p["id"] for p in personas) == ["C", "D"]  # not ["C", "C", "D"]


def test_graph_personas_hydrate_false_skips_url_signing(monkeypatch):
    graph = buildGraph(monkeypatch)
    personas = reads_module.graphPersonas(graph, {"C"}, hydrate=False)
    assert "url" not in personas[0]["profile_photo"]


def test_graph_persona_by_id_finds_root():
    structure = factories.caseStructure(personas=[factories.persona("A")], referrals=[], roots=["A"])
    root_rows, edges = reads_module.flattenPersonas(structure)
    graph = {"root_personas": root_rows, "referrals": edges}
    result = reads_module.graphPersonaById(graph, "A")
    assert result is not None
    assert result["id"] == "A"


def test_graph_persona_by_id_finds_referred():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B")],
        roots=["A"],
    )
    root_rows, edges = reads_module.flattenPersonas(structure)
    graph = {"root_personas": root_rows, "referrals": edges}
    result = reads_module.graphPersonaById(graph, "B")
    assert result is not None
    assert result["id"] == "B"


def test_graph_persona_by_id_returns_none_for_unknown():
    graph = {"root_personas": [], "referrals": []}
    assert reads_module.graphPersonaById(graph, "nope") is None
