from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from settings import MAX_SIMULATION_DURATION_MINUTES


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
    profilePhoto: Optional[FileRef] = None
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
    accessCode: Optional[str] = None
    totalNonReferredPersonas: int
    personas: List[PersonaPayload] = Field(default_factory=list)

    @field_validator("simulationDurationMinutes")
    @classmethod
    def _cap_simulation_duration(cls, value: Optional[int]) -> Optional[int]:
        # The admin form caps this client-side too, but that's UX only — this
        # is the actual guarantee (see settings.MAX_SIMULATION_DURATION_MINUTES).
        if value is not None and value > MAX_SIMULATION_DURATION_MINUTES:
            raise ValueError(
                f"Simulation duration cannot exceed {MAX_SIMULATION_DURATION_MINUTES} minutes."
            )
        return value
