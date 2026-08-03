"""Payload/graph builders shared by every test.

These used to be copy-pasted into each integration test file (four identical
copies of makePayload/createPayload/updatePayload/asCurrentAdmin), which meant
a change to CasePayload's required fields broke four files and, worse, let a
file drift silently. Everything now builds off `casePayload` below, so a new
required field is one edit.
"""

from __future__ import annotations

from typing import Any

from models.admin import AdminRole
from models.cases import CasePayload, CaseStructure, CaseUpdatePayload
from models.simulation_runtime import PersonaGraph, Run, RunCaseSnapshot
from services.auth import CurrentAdmin


def casePayload(**overrides: Any) -> dict:
    """The minimum valid case body, as a plain dict, before model validation."""
    base: dict[str, Any] = dict(
        case_name="Test Case",
        initial_brief="brief",
        common_information=None,
        simulation_duration=None,
        access_code=None,
        personas=[],
        referrals=[],
        roots=[],
        collaborator_admin_ids=[],
    )
    base.update(overrides)
    return base


def createPayload(**overrides: Any) -> CasePayload:
    return CasePayload(**casePayload(**overrides))


def updatePayload(expected_version: int, **overrides: Any) -> CaseUpdatePayload:
    return CaseUpdatePayload(**casePayload(**overrides), expected_version=expected_version)


def asCurrentAdmin(admin) -> CurrentAdmin:
    """An Admin row (from the `cleanup.make_admin` fixture) as the auth tuple
    the service layer actually takes."""
    return CurrentAdmin(id=admin.id, role=AdminRole(admin.role))


# --- persona graph pieces -------------------------------------------------


def persona(persona_id: str, **overrides: Any) -> dict:
    base: dict[str, Any] = dict(
        id=persona_id,
        name=f"Persona {persona_id}",
        role="Role",
        profile_photo=None,
        known_facts=None,
        personality_traits=None,
        availability_minutes=None,
        files=[],
    )
    base.update(overrides)
    return base


def referral(from_id: str, to_id: str, conditions: str | None = None) -> dict:
    return {"from_id": from_id, "to_id": to_id, "conditions": conditions}


def fileEntry(
    *,
    file_id: str | None = "1",
    object_key: str = "cases/test/doc.pdf",
    file_name: str = "doc.pdf",
    content_type: str | None = "application/pdf",
    share_conditions: str | None = "the user asks about the budget",
    perceived_contents: str | None = "last quarter's budget",
) -> dict:
    """A persona-attached file in the *stored* shape (i.e. after
    services.cases.resolveFileRef has assigned a file_id)."""
    return {
        "file": {
            "file_id": file_id,
            "object_key": object_key,
            "file_name": file_name,
            "content_type": content_type,
        },
        "share_conditions": share_conditions,
        "perceived_contents": perceived_contents,
    }


def run(**overrides: Any) -> Run:
    """A minimal-but-realistic Run instance, for tests that exercise
    turn_state/run_store helpers directly against a valid Run shell rather
    than driving a full turn through the `sim` fixture."""
    base: dict[str, Any] = dict(
        case_id=1,
        case_snapshot=RunCaseSnapshot(id=1, case_name="Case", initial_brief="Brief", simulation_duration=None),
        persona_graph=PersonaGraph(),
        start_time=1000.0,
        active_persona_id="A",
    )
    base.update(overrides)
    return Run(**base)


def caseStructure(
    *,
    personas: list[dict] | None = None,
    referrals: list[dict] | None = None,
    roots: list[str] | None = None,
) -> CaseStructure:
    """A parsed CaseStructure — the exact shape Case.structure holds in JSONB."""
    return CaseStructure.model_validate(
        {
            "personas": personas if personas is not None else [persona("A")],
            "referrals": referrals or [],
            "roots": roots if roots is not None else ["A"],
        }
    )
