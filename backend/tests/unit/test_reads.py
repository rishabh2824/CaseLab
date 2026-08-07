"""services/simulation/reads.py — pure shaping of persona-graph data.

reads.py never touches Spaces (see services/simulation/state.py::hydratePersona,
which is where a signed profile-photo URL gets attached) — every persona these
functions hand back is raw, so nothing here needs to patch anything impure.
"""

from __future__ import annotations

from types import SimpleNamespace

from models.cases import PersonaPayload
from models.runtime import PersonaGraph, CaseSnapshot
from services.simulation import reads as reads_module

from tests import factories


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
    assert reads_module.caseSnapshot(case) == CaseSnapshot(
        id=1,
        case_name="Sterling Industries",
        brief="Reduce office supply costs.",
        simulation_duration=45,
        common_information="Background.",
        access_code="STERLING",
    )


# --------------------------------------------------------------------------
# getPersonaDetails
# --------------------------------------------------------------------------


def personaPayload(**overrides) -> PersonaPayload:
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
    return PersonaPayload.model_validate(data)


def test_get_persona_details_carries_secrets_and_renames_duration_field():
    row = reads_module.getPersonaDetails(personaPayload())
    assert row.known_facts == "secret facts"
    assert row.personality_traits == "calm"
    assert row.availability_duration == 30  # availability_minutes -> availability_duration
    assert len(row.files) == 1
    assert row.is_referred is False  # not asked, so left at its default


def test_get_persona_details_is_referred_only_when_asked():
    row = reads_module.getPersonaDetails(personaPayload(), is_referred=True)
    assert row.is_referred is True


# --------------------------------------------------------------------------
# flattenPersonas
# --------------------------------------------------------------------------


def test_flatten_personas_root_rows_sorted_by_name():
    structure = factories.caseStructure(
        personas=[factories.persona("A", name="Zed"), factories.persona("B", name="Alice")],
        referrals=[],
        roots=["A", "B"],
    )
    graph = reads_module.flattenPersonas(structure)
    assert [graph.personas[pid].name for pid in graph.roots] == ["Alice", "Zed"]


def test_flatten_personas_every_referral_becomes_an_edge():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B", conditions=None)],
        roots=["A"],
    )
    graph = reads_module.flattenPersonas(structure)
    assert len(graph.referrals) == 1
    edge = graph.referrals[0]
    assert edge.parent_persona_id == "A"
    assert edge.referred_persona_id == "B"
    assert edge.condition_trigger == ""  # None condition becomes ""
    assert graph.personas[edge.referred_persona_id].is_referred is True


def test_flatten_personas_persona_referred_by_two_parents_is_stored_once():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B"), factories.persona("C")],
        referrals=[factories.referral("A", "C"), factories.referral("B", "C")],
        roots=["A", "B"],
    )
    graph = reads_module.flattenPersonas(structure)
    targets = [(e.parent_persona_id, e.referred_persona_id) for e in graph.referrals]
    assert set(targets) == {("A", "C"), ("B", "C")}
    # Both edges point at the same persona — it must be stored once, not duplicated per edge.
    assert len(graph.personas) == 3


def test_flatten_personas_persona_that_is_both_root_and_referral_target():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B")],
        roots=["A", "B"],
    )
    graph = reads_module.flattenPersonas(structure)
    assert set(graph.roots) == {"A", "B"}
    assert graph.referrals[0].referred_persona_id == "B"
    assert "B" in graph.personas  # stored once, not a separate referred-copy


# --------------------------------------------------------------------------
# graphReferrals / graphPersonas / graphPersonaById
# --------------------------------------------------------------------------


def buildGraph() -> PersonaGraph:
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
    return reads_module.flattenPersonas(structure)


def test_graph_referrals_filters_by_parent(monkeypatch):
    graph = buildGraph()
    referrals = reads_module.graphReferrals(graph, "A")
    referred_ids = {edge.referred_persona_id for edge in referrals}
    assert referred_ids == {"C", "D"}
    # Raw, unhydrated persona — reads.py never signs a profile-photo URL.
    c_edge = next(edge for edge in referrals if edge.referred_persona_id == "C")
    c_persona = graph.personas[c_edge.referred_persona_id]
    assert c_persona.profile_photo_url is None
    assert c_persona.profile_photo.object_key == "cases/1/c.png"


def test_graph_personas_deduplicates_when_two_edges_point_at_the_same_persona():
    graph = buildGraph()
    personas = reads_module.graphPersonas(graph, {"C", "D"})
    assert sorted(p.id for p in personas) == ["C", "D"]  # not ["C", "C", "D"]


def test_graph_personas_returns_raw_unhydrated_personas():
    graph = buildGraph()
    personas = reads_module.graphPersonas(graph, {"C"})
    assert personas[0].profile_photo_url is None


def test_graph_persona_by_id_finds_root():
    structure = factories.caseStructure(personas=[factories.persona("A")], referrals=[], roots=["A"])
    graph = reads_module.flattenPersonas(structure)
    result = reads_module.graphPersonaById(graph, "A")
    assert result is not None
    assert result.id == "A"


def test_graph_persona_by_id_finds_referred():
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B")],
        roots=["A"],
    )
    graph = reads_module.flattenPersonas(structure)
    result = reads_module.graphPersonaById(graph, "B")
    assert result is not None
    assert result.id == "B"


def test_graph_persona_by_id_returns_none_for_unknown():
    graph = PersonaGraph()
    assert reads_module.graphPersonaById(graph, "nope") is None
