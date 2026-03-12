from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class FileRef(BaseModel):
    bucket: str
    object_key: str
    file_name: str
    content_type: Optional[str] = None


class FileEntry(BaseModel):
    file: Optional[FileRef] = None
    shareConditions: Optional[str] = None
    perceivedContents: Optional[str] = None


class ReferralPayload(BaseModel):
    name: Optional[str] = ""
    triggerType: Optional[str] = None
    conditions: Optional[str] = None
    revealDelayMinutes: Optional[int] = None
    persona: PersonaPayload


class PersonaPayload(BaseModel):
    name: str = ""
    role: str = ""
    knownFacts: Optional[str] = None
    unknownFacts: Optional[str] = None
    hiddenFacts: Optional[str] = None
    personalityTraits: Optional[str] = None
    scheduledAfterMinutes: Optional[int] = None
    availabilityMinutes: Optional[int] = None
    fileCount: Optional[int] = None
    files: List[FileEntry] = Field(default_factory=list)
    referralOutCount: Optional[int] = None
    referrals: List[ReferralPayload] = Field(default_factory=list)


if hasattr(ReferralPayload, "model_rebuild"):
    ReferralPayload.model_rebuild()
else:
    ReferralPayload.update_forward_refs()


class CasePayload(BaseModel):
    caseName: str
    initialBrief: str
    commonInformation: Optional[str] = None
    simulationDurationMinutes: Optional[int] = None
    totalNonReferredPersonas: int
    personas: List[PersonaPayload] = Field(default_factory=list)
