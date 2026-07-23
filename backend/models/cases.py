from __future__ import annotations
from pydantic import BaseModel, Field
from infra.settings import SIMULATION_DURATION


class FileRef(BaseModel):
    object_key: str
    file_name: str
    content_type: str | None = None


class FileEntry(BaseModel):
    file: FileRef | None = None
    share_conditions: str | None = None
    perceived_contents: str | None = None


class ReferralPayload(BaseModel):
    conditions: str | None = None
    persona: PersonaPayload


class PersonaPayload(BaseModel):
    name: str = ""
    role: str = ""
    profile_photo: FileRef | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    availability_minutes: int | None = None
    files: list[FileEntry] = Field(default_factory=list)
    referrals: list[ReferralPayload] = Field(default_factory=list)


ReferralPayload.model_rebuild()


class CasePayload(BaseModel):
    case_name: str
    initial_brief: str
    common_information: str | None = None
    simulation_duration: int | None = Field(default=None, ge=1, le=SIMULATION_DURATION)
    access_code: str | None = None
    total_non_referred_personas: int
    personas: list[PersonaPayload] = Field(default_factory=list)
    collaborator_admin_ids: list[int] = Field(default_factory=list)


# PUT-only: carries the version the client last loaded, so updateCase can reject
# with a 409 if someone else saved in between (see services/cases.py).
class CaseUpdatePayload(CasePayload):
    expected_version: int


# --- Response models, mirroring services/cases.py's return shapes exactly ----

class ReferralOut(BaseModel):
    name: str
    conditions: str | None = None
    persona: PersonaOut


# adminTree()'s shape: a PersonaPayload plus the two derived counts the admin
# UI reads back (file_count / referral_out_count).
class PersonaOut(BaseModel):
    name: str
    role: str
    profile_photo: FileRef | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    availability_minutes: int | None = None
    file_count: int
    files: list[FileEntry] = Field(default_factory=list)
    referral_out_count: int
    referrals: list[ReferralOut] = Field(default_factory=list)


ReferralOut.model_rebuild()


class CaseSummary(BaseModel):
    id: int
    case_name: str
    access_code: str | None = None


class CaseListResponse(BaseModel):
    cases: list[CaseSummary]


class CaseDetail(BaseModel):
    id: int
    case_name: str
    access_code: str | None = None
    initial_brief: str
    common_information: str | None = None
    simulation_duration: int | None = None
    total_non_referred_personas: int
    personas: list[PersonaOut] = Field(default_factory=list)
    version: int
    owner_admin_id: int
    collaborator_admin_ids: list[int] = Field(default_factory=list)


class CaseDetailResponse(BaseModel):
    case: CaseDetail


# Shared by createCase and updateCase, both of which return only {"case_id": ...}.
class CaseCreatedResponse(BaseModel):
    case_id: int


class CaseDeletedResponse(BaseModel):
    ok: bool


# GET /cases/{case_id}/version — the lightweight poll endpoint CaseForm.svelte
# hits while a case is open for editing, to detect a concurrent save.
class CaseVersionResponse(BaseModel):
    version: int
