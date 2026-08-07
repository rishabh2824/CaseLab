from pydantic import BaseModel, Field
from domain_constants import SIMULATION_DURATION


class FileRef(BaseModel):
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


class ReferralEdge(BaseModel):
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
    referrals: list[ReferralEdge] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)
    collaborator_admin_ids: list[int] = Field(default_factory=list)


class CaseUpdate(CasePayload):
    expected_version: int


class CaseStructure(BaseModel):
    personas: list[PersonaPayload] = Field(default_factory=list)
    referrals: list[ReferralEdge] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)


class CaseSummary(BaseModel):
    id: int
    case_name: str
    access_code: str | None = None


class CaseList(BaseModel):
    cases: list[CaseSummary]


class CaseDetail(BaseModel):
    id: int | None = None
    case_name: str
    access_code: str | None = None
    brief: str
    common_information: str | None = None
    simulation_duration: int | None = None
    personas: list[PersonaPayload] = Field(default_factory=list)
    referrals: list[ReferralEdge] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)
    version: int | None = None
    owner_admin_id: int | None = None
    collaborator_admin_ids: list[int] | None = None


class CaseDetailResponse(BaseModel):
    case: CaseDetail


class CaseCreated(BaseModel):
    case_id: int


class CaseDeleted(BaseModel):
    ok: bool


class CaseVersion(BaseModel):
    version: int
