from pydantic import BaseModel, Field
from domain_constants import SIMULATION_DURATION


class FileRef(BaseModel):
    # file_id is never sent by the client — resolveFileRef (services/cases.py)
    # fills it in server-side on save, and it must round-trip through
    # CaseStructure on every later read since services/simulation/service.py
    # keys run["shared_files"] by it.
    file_id: str | None = None
    object_key: str
    file_name: str
    content_type: str | None = None


class FileEntry(BaseModel):
    file: FileRef | None = None
    share_conditions: str | None = None
    perceived_contents: str | None = None


class PersonaPayload(BaseModel):
    id: str
    name: str = ""
    role: str = ""
    profile_photo: FileRef | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    availability_minutes: int | None = None
    files: list[FileEntry] = Field(default_factory=list)


class ReferralEdgePayload(BaseModel):
    from_id: str
    to_id: str
    conditions: str | None = None


class CasePayload(BaseModel):
    case_name: str
    brief: str
    common_information: str | None = None
    simulation_duration: int | None = Field(default=None, ge=1, le=SIMULATION_DURATION)
    access_code: str | None = None
    personas: list[PersonaPayload] = Field(default_factory=list)
    referrals: list[ReferralEdgePayload] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)
    collaborator_admin_ids: list[int] = Field(default_factory=list)


# PUT-only: carries the version the client last loaded, so updateCase can reject
# with a 409 if someone else saved in between (see services/cases.py).
class CaseUpdatePayload(CasePayload):
    expected_version: int


# getCase/getDemoCase build their responses out of actual instances of PersonaPayload/
# ReferralEdgePayload (via CaseStructure below), not hand-built dicts kept in sync by
# convention. Response and request share the same shape — nothing diverges between them.

# The single parsed shape of Case.structure/DemoCase's structure — every reader
# of the JSONB blob parses into this once at the read boundary instead of
# re-deriving its own defensive .get(x) or default shaping.
class CaseStructure(BaseModel):
    personas: list[PersonaPayload] = Field(default_factory=list)
    referrals: list[ReferralEdgePayload] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)


class CaseSummary(BaseModel):
    id: int
    case_name: str
    access_code: str | None = None


class CaseListResponse(BaseModel):
    cases: list[CaseSummary]


# id/version/owner_admin_id/collaborator_admin_ids are None for the demo case (see
# services/cases.py::getDemoCase) — meaningless to a viewer who isn't actually the demo
# case's owner/collaborator. The /demo route serializes with response_model_exclude_none
# so those keys are absent from the JSON entirely, not just null (see api/cases.py).
class CaseDetail(BaseModel):
    id: int | None = None
    case_name: str
    access_code: str | None = None
    brief: str
    common_information: str | None = None
    simulation_duration: int | None = None
    personas: list[PersonaPayload] = Field(default_factory=list)
    referrals: list[ReferralEdgePayload] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)
    version: int | None = None
    owner_admin_id: int | None = None
    collaborator_admin_ids: list[int] | None = None


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
