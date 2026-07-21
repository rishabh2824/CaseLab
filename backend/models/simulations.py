from typing import Literal
from pydantic import BaseModel, Field


class StartSimulationPayload(BaseModel):
    access_code: str


class SendMessagePayload(BaseModel):
    persona_id: str
    message: str


class NotesPayload(BaseModel):
    notes: str


# --- Response models, mirroring services/simulation/service.py's return shapes exactly ----

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


# The trimmed case shape embedded in RunStateResponse (startSimulation / getSimulationState).
class RunCaseSummary(BaseModel):
    id: int
    case_name: str
    initial_brief: str
    simulation_duration: int | None = None


# hydratePersona()'s re-signed photo shape — distinct from cases.FileRef, which
# is the admin-facing shape with no file_id/url.
class PersonaPhotoOut(BaseModel):
    file_id: str | None = None
    object_key: str
    file_name: str
    content_type: str | None = None
    url: str


# buildContact()'s shape after stripping secrets (files, known_facts, personality_traits).
class ContactOut(BaseModel):
    id: str
    name: str
    role: str
    profile_photo: PersonaPhotoOut | None = None
    availability_duration: int | None = None
    is_referred: bool
    available: bool
    available_in: int | None = None
    expires_in: int | None = None
    chat_ended: bool
    chat_end_reason: str | None = None
    warning_count: int


class SharedFileOut(BaseModel):
    file_id: str
    file_name: str
    content_type: str | None = None
    url: str


# Shared by startSimulation and getSimulationState, which return the same shape.
class RunStateResponse(BaseModel):
    run_id: str
    case: RunCaseSummary
    contacts: list[ContactOut]
    active_persona_id: str
    shared_files: list[SharedFileOut]
    histories: dict[str, list[ChatMessage]]
    notes: str


class ExportCaseSummary(BaseModel):
    id: int
    case_name: str


class ExportPersonaOut(BaseModel):
    id: str
    name: str
    role: str
    messages: list[ChatMessage]


class ExportResponse(BaseModel):
    case: ExportCaseSummary
    personas: list[ExportPersonaOut] = Field(default_factory=list)


class NotesResponse(BaseModel):
    notes: str
