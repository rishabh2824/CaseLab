from typing import Literal
from pydantic import BaseModel, Field


class StartSimulationPayload(BaseModel):
    access_code: str


class SendMessagePayload(BaseModel):
    persona_id: str
    message: str


class NotesPayload(BaseModel):
    notes: str


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class RunCaseSummary(BaseModel):
    id: int
    case_name: str
    initial_brief: str
    simulation_duration: int | None = None


class PersonaPhotoOut(BaseModel):
    file_id: str | None = None
    object_key: str
    file_name: str
    content_type: str | None = None
    url: str


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
