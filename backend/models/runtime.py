from typing import Literal
from pydantic import BaseModel, Field
from models.cases import FileRef, FileEntry
from models.simulations import ChatMessage, ContactOut, SharedFileOut


class ChatState(BaseModel):
    warning_count: int = 0
    ended: bool = False
    end_reason: str | None = None
    last_flag_type: str | None = None


class PersonaDetail(BaseModel):
    id: str
    name: str
    role: str
    profile_photo: FileRef | None = None
    profile_photo_url: str | None = None
    availability_duration: int | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    files: list[FileEntry] = Field(default_factory=list)
    is_referred: bool = False


class Referral(BaseModel):
    parent_persona_id: str
    referred_persona_id: str
    condition_trigger: str


class DecisionBundle(BaseModel):
    referrals: list[Referral]
    persona_details: PersonaDetail
    pending_referrals: list[Referral]
    pending_files: list[FileEntry]
    referral_results: list[bool]
    file_results: list[bool]


class PersonaGraph(BaseModel):
    personas: dict[str, PersonaDetail] = Field(default_factory=dict)
    referrals: list[Referral] = Field(default_factory=list)
    roots: list[str] = Field(default_factory=list)


class CaseSnapshot(BaseModel):
    id: int
    case_name: str
    brief: str
    simulation_duration: int | None = None
    common_information: str | None = None
    access_code: str | None = None


class FileRecord(BaseModel):
    file_id: str
    file_name: str
    content_type: str | None = None
    object_key: str


class RunSnapshot(BaseModel):
    case_snapshot: CaseSnapshot
    persona_graph: PersonaGraph


class RunState(BaseModel):
    active_persona_id: str
    unlocked_referred_ids: set[str] = Field(default_factory=set)
    unlocked_at: dict[str, int] = Field(default_factory=dict)
    shared_files: dict[str, FileRecord] = Field(default_factory=dict)
    persona_chat_state: dict[str, ChatState] = Field(default_factory=dict)


class Run(BaseModel):
    case_snapshot: CaseSnapshot
    persona_graph: PersonaGraph
    start_time: float
    active_persona_id: str
    unlocked_referred_ids: set[str] = Field(default_factory=set)
    unlocked_at: dict[str, int] = Field(default_factory=dict)
    shared_files: dict[str, FileRecord] = Field(default_factory=dict)
    history: dict[str, list[ChatMessage]] = Field(default_factory=dict)
    persona_chat_state: dict[str, ChatState] = Field(default_factory=dict)
    pending_messages: list[tuple[str, ChatMessage]] = Field(default_factory=list)


class NormalTurn(BaseModel):
    kind: Literal["normal"] = "normal"
    run_id: str
    persona_id: str
    messages: list[dict]
    referral_handles: dict[str, Referral]
    file_handles: dict[str, FileEntry]


class TurnMeta(BaseModel):
    new_contacts: list[ContactOut] = Field(default_factory=list)
    shared_files: list[SharedFileOut] = Field(default_factory=list)
    chat_ended: bool
    chat_end_reason: str | None
    warning_count: int


class BoundaryTurn(BaseModel):
    kind: Literal["boundary"] = "boundary"
    run_id: str
    persona_id: str
    reply: str
    meta: TurnMeta


PreparedTurn = NormalTurn | BoundaryTurn


class DeltaFrame(BaseModel):
    text: str


class DoneFrame(BaseModel):
    reply: str


class ErrorFrame(BaseModel):
    detail: str
    code: str | None = None
