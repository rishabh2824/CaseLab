from typing import TYPE_CHECKING, Literal
from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from models.simulation_runtime import ChatState, PersonaDetail


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

    # Reads an explicit allow-list of fields off PersonaDetail only — never a
    # dict spread, never a .pop(...). A future secret field added to
    # PersonaDetail is invisible here unless someone deliberately adds a line,
    # which is the structural fix for the old pop-and-hope pattern.
    @classmethod
    def from_persona_detail(
        cls, persona: PersonaDetail, *, is_referred: bool,
        available: bool, available_in: int | None, expires_in: int | None,
        chat_state: ChatState,
    ) -> ContactOut:
        return cls(
            id=persona.id, name=persona.name, role=persona.role,
            profile_photo=(
                PersonaPhotoOut(
                    file_id=persona.profile_photo.file_id, object_key=persona.profile_photo.object_key,
                    file_name=persona.profile_photo.file_name, content_type=persona.profile_photo.content_type,
                    url=persona.profile_photo_url,
                ) if persona.profile_photo else None
            ),
            availability_duration=persona.availability_duration,
            is_referred=is_referred, available=available,
            available_in=available_in, expires_in=expires_in,
            chat_ended=chat_state.ended, chat_end_reason=chat_state.end_reason,
            warning_count=chat_state.warning_count,
        )


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
