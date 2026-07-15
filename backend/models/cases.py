from __future__ import annotations
from pydantic import BaseModel, Field
from infra.settings import MAX_SIMULATION_DURATION


class FileRef(BaseModel):
    bucket: str
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
    simulation_duration: int | None = Field(default=None, ge=1, le=MAX_SIMULATION_DURATION)
    access_code: str | None = None
    total_non_referred_personas: int
    personas: list[PersonaPayload] = Field(default_factory=list)
