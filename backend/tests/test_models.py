"""Pydantic payload validation."""

import pytest
from pydantic import ValidationError

from infra.settings import MAX_SIMULATION_DURATION
from models.cases import CasePayload, PersonaPayload


def _case(**over):
    base = {
        "case_name": "Test Case",
        "initial_brief": "Brief.",
        "total_non_referred_personas": 1,
    }
    base.update(over)
    return base


class TestCasePayload:
    def test_minimal_valid_payload(self):
        case = CasePayload(**_case())
        assert case.case_name == "Test Case"
        assert case.simulation_duration is None
        assert case.personas == []

    def test_duration_within_bounds_accepted(self):
        assert CasePayload(**_case(simulation_duration=45)).simulation_duration == 45
        assert CasePayload(**_case(simulation_duration=1)).simulation_duration == 1
        assert CasePayload(**_case(simulation_duration=MAX_SIMULATION_DURATION)).simulation_duration == MAX_SIMULATION_DURATION

    def test_duration_zero_rejected(self):
        with pytest.raises(ValidationError):
            CasePayload(**_case(simulation_duration=0))

    def test_duration_over_cap_rejected(self):
        with pytest.raises(ValidationError):
            CasePayload(**_case(simulation_duration=MAX_SIMULATION_DURATION + 1))

    def test_missing_required_field_rejected(self):
        with pytest.raises(ValidationError):
            CasePayload(case_name="x", initial_brief="y")  # no total_non_referred_personas


class TestPersonaPayload:
    def test_defaults(self):
        p = PersonaPayload()
        assert p.name == ""
        assert p.role == ""
        assert p.files == []
        assert p.referrals == []

    def test_nested_referral_persona(self):
        p = PersonaPayload(
            name="Root",
            referrals=[{"conditions": "when asked", "persona": {"name": "Child", "role": "Analyst"}}],
        )
        assert p.referrals[0].persona.name == "Child"
