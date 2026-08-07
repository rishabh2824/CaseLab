"""services/cases.py — validateGraph and the other pure helpers that don't
need a database: normalizeAccessCode and violation (the IntegrityError sniffer
used to turn a duplicate access_code into a friendly 409 — constraint-name-aware
so it doesn't also fire for an unrelated UNIQUE violation like uq_files_object_key).
"""

from __future__ import annotations

import pytest
from hypothesis import given, strategies as st
from sqlalchemy.exc import IntegrityError

from domain_errors import InvalidRequest
from services import cases as case_service

from tests import factories


# --------------------------------------------------------------------------
# validateGraph
# --------------------------------------------------------------------------


def test_validate_graph_accepts_an_empty_graph():
    payload = factories.createPayload(personas=[], referrals=[], roots=[])
    case_service.validateGraph(payload)  # must not raise


def test_validate_graph_rejects_duplicate_persona_ids():
    payload = factories.createPayload(
        personas=[factories.persona("A", name="First"), factories.persona("A", name="Second")],
        referrals=[],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_unknown_root():
    payload = factories.createPayload(personas=[factories.persona("A")], referrals=[], roots=["A", "ghost"])
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_unknown_referral_from_id():
    payload = factories.createPayload(
        personas=[factories.persona("A")],
        referrals=[factories.referral("ghost", "A")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_unknown_referral_to_id():
    payload = factories.createPayload(
        personas=[factories.persona("A")],
        referrals=[factories.referral("A", "ghost")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_self_referral_cycle():
    payload = factories.createPayload(
        personas=[factories.persona("A")],
        referrals=[factories.referral("A", "A")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_a_two_cycle():
    payload = factories.createPayload(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B"), factories.referral("B", "A")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_a_longer_cycle():
    payload = factories.createPayload(
        personas=[factories.persona("A"), factories.persona("B"), factories.persona("C")],
        referrals=[factories.referral("A", "B"), factories.referral("B", "C"), factories.referral("C", "A")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_rejects_a_cycle_disconnected_from_any_root():
    # B/C form a cycle that no root can ever reach — still invalid, since the
    # DFS in validateGraph walks every persona id, not just ones reachable
    # from a root.
    payload = factories.createPayload(
        personas=[factories.persona("A"), factories.persona("B"), factories.persona("C")],
        referrals=[factories.referral("B", "C"), factories.referral("C", "B")],
        roots=["A"],
    )
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(payload)


def test_validate_graph_accepts_a_valid_diamond():
    # Two parents referring the same child is exactly the shape the flat
    # referral-graph storage was built to allow (see
    # tests/integration/test_case_persona_graph.py).
    payload = factories.createPayload(
        personas=[factories.persona("A"), factories.persona("B"), factories.persona("C")],
        referrals=[factories.referral("A", "C"), factories.referral("B", "C")],
        roots=["A", "B"],
    )
    case_service.validateGraph(payload)  # must not raise


# --------------------------------------------------------------------------
# property test: any random DAG validates; any DAG + a back edge does not
# --------------------------------------------------------------------------


@st.composite
def dagWithGuaranteedChain(draw):
    """A random DAG that is guaranteed connected end-to-end via a chain
    ids[0] -> ids[1] -> ... -> ids[n-1], plus a random subset of additional
    forward (lower index -> higher index) edges. The guaranteed chain is
    what lets the caller add a single "close the loop" edge (last -> first)
    and be certain it creates a cycle, regardless of which extra edges were
    drawn.
    """
    n = draw(st.integers(min_value=2, max_value=6))
    ids = [f"P{i}" for i in range(n)]
    chain_edges = [(ids[i], ids[i + 1]) for i in range(n - 1)]
    extra_candidates = [
        (ids[i], ids[j]) for i in range(n) for j in range(i + 1, n) if (ids[i], ids[j]) not in chain_edges
    ]
    extra_edges = draw(st.lists(st.sampled_from(extra_candidates), unique=True)) if extra_candidates else []
    roots = draw(st.lists(st.sampled_from(ids), unique=True))
    return ids, chain_edges + extra_edges, roots


@given(dagWithGuaranteedChain())
def test_any_dag_validates_and_adding_a_back_edge_always_raises(data):
    ids, edges, roots = data
    personas = [factories.persona(pid) for pid in ids]
    referrals = [factories.referral(a, b) for a, b in edges]

    valid_payload = factories.createPayload(personas=personas, referrals=referrals, roots=roots)
    case_service.validateGraph(valid_payload)  # must not raise

    back_edge = factories.referral(ids[-1], ids[0])
    cyclic_payload = factories.createPayload(personas=personas, referrals=[*referrals, back_edge], roots=roots)
    with pytest.raises(InvalidRequest):
        case_service.validateGraph(cyclic_payload)


# --------------------------------------------------------------------------
# normalizeAccessCode
# --------------------------------------------------------------------------


def test_normalize_access_code_none_stays_none():
    assert case_service.normalizeAccessCode(None) is None


def test_normalize_access_code_whitespace_only_becomes_none():
    assert case_service.normalizeAccessCode("   ") is None


def test_normalize_access_code_trims_whitespace():
    assert case_service.normalizeAccessCode("  STERLING  ") == "STERLING"


# --------------------------------------------------------------------------
# violation
# --------------------------------------------------------------------------


class FakeOrig(Exception):
    def __init__(self, constraint_name):
        self.constraint_name = constraint_name


def test_violation_true_for_the_named_constraint():
    exc = IntegrityError("stmt", {}, FakeOrig("idx_cases_access_code_unique"))
    assert case_service.violation(exc, "idx_cases_access_code_unique") is True


def test_violation_false_for_a_different_constraint():
    # A real UNIQUE violation (uq_files_object_key, e.g. two concurrent requests
    # creating the same brand-new file) — just not the one the caller asked about.
    exc = IntegrityError("stmt", {}, FakeOrig("uq_files_object_key"))
    assert case_service.violation(exc, "idx_cases_access_code_unique") is False


def test_violation_false_for_non_integrity_error():
    assert case_service.violation(ValueError("not an integrity error"), "idx_cases_access_code_unique") is False
