from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from settings import MAX_SIMULATION_DURATION_MINUTES


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
    # No `name` field: it's a client-form display label for the referral's
    # accordion item (kept in sync with `persona.name` in the UI) that the
    # backend never reads — the persona's own `name` below is what's stored.
    # No `trigger_type`: the "After N time" option is no longer offered, and
    # the column itself is gone — every referral is condition-based.
    conditions: str | None = None
    persona: PersonaPayload


class PersonaPayload(BaseModel):
    name: str = ""
    role: str = ""
    profile_photo: FileRef | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    availability_minutes: int | None = None
    # No `file_count`/`referral_out_count`: client-only UI counters for how
    # many file/referral sub-forms to render — the backend only cares about
    # the actual `files`/`referrals` arrays below.
    files: list[FileEntry] = Field(default_factory=list)
    referrals: list[ReferralPayload] = Field(default_factory=list)


ReferralPayload.model_rebuild()


class CasePayload(BaseModel):
    case_name: str
    initial_brief: str
    common_information: str | None = None
    simulation_duration: int | None = None
    access_code: str | None = None
    total_non_referred_personas: int
    personas: list[PersonaPayload] = Field(default_factory=list)

    @field_validator("simulation_duration")
    @classmethod
    def _cap_simulation_duration(cls, value: int | None) -> int | None:
        # The admin form caps this client-side too, but that's UX only — this
        # is the actual guarantee (see settings.MAX_SIMULATION_DURATION_MINUTES).
        if value is not None and value > MAX_SIMULATION_DURATION_MINUTES:
            raise ValueError(
                f"Simulation duration cannot exceed {MAX_SIMULATION_DURATION_MINUTES} minutes."
            )
        return value
