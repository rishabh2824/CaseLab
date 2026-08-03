from typing import Literal
from pydantic import BaseModel, Field
from models.cases import FileRef, FileEntry
from models.simulations import ChatMessage, ContactOut, SharedFileOut

# Internal simulation-runtime record types.
#
# None of these set `model_config = ConfigDict(validate_assignment=True)`.
# Run is validated at exactly two points: Run.model_validate(row.data) on load
# from JSONB, and run.model_dump(mode="json") on save. Between those points,
# inside one updateRun(run_id, fn) transaction, mutate these objects in place
# (attribute assignment, dict/set mutation) — never re-validate or
# model_copy() a Run/ChatState/etc. mid-transaction; model_copy() is reserved
# for the one legitimate non-transactional case (hydratePersona in reads.py).


class ChatState(BaseModel):
    warning_count: int = 0
    ended: bool = False
    end_reason: str | None = None
    last_flag_type: str | None = None


class PersonaDetail(BaseModel):
    id: str
    name: str
    role: str
    # Matches PersonaOut.profile_photo exactly (no url) — the persona graph is
    # cached in the run blob with a raw file reference, never a signed URL, so
    # hydratePersona can re-derive a fresh one at read time instead of a
    # persisted URL going stale. profile_photo_url is set only by
    # hydratePersona and is never meaningfully persisted.
    profile_photo: FileRef | None = None
    profile_photo_url: str | None = None
    availability_duration: int | None = None
    known_facts: str | None = None
    personality_traits: str | None = None
    files: list[FileEntry] = Field(default_factory=list)
    is_referred: bool = False


class Referral(BaseModel):
    # Field names deliberately diverge from the wire ReferralEdgePayload/ReferralOut
    # (from_id/to_id/conditions) — this is an internal run-blob cache shape, not
    # the case storage/wire contract.
    parent_persona_id: str
    referred_persona_id: str
    condition_trigger: str
    persona: PersonaDetail


class PersonaGraph(BaseModel):
    # root_personas here (list[PersonaDetail]) shares a name with Case.root_personas
    # (an int row-count column, infra/db_models.py) purely as a historical dict-key
    # coincidence — they're unrelated fields on unrelated classes, not a namespace
    # collision, so the name is kept rather than renamed to `roots` (which would
    # collide in meaning, if not in Python identity, with CaseStructure.roots:
    # list[str], a list of persona IDs, not PersonaDetail objects).
    root_personas: list[PersonaDetail] = Field(default_factory=list)
    referrals: list[Referral] = Field(default_factory=list)


class RunCaseSnapshot(BaseModel):
    id: int
    case_name: str
    initial_brief: str
    simulation_duration: int | None = None
    common_information: str | None = None
    access_code: str | None = None


class SharedFileRecord(BaseModel):
    file_id: str
    file_name: str
    content_type: str | None = None
    object_key: str


class Run(BaseModel):
    case_id: int
    case_snapshot: RunCaseSnapshot
    persona_graph: PersonaGraph
    start_time: float
    active_persona_id: str
    unlocked_referred_ids: set[str] = Field(default_factory=set)
    unlocked_at: dict[str, int] = Field(default_factory=dict)
    shared_files: dict[str, SharedFileRecord] = Field(default_factory=dict)
    history: dict[str, list[ChatMessage]] = Field(default_factory=dict)
    persona_chat_state: dict[str, ChatState] = Field(default_factory=dict)
    notes: str = ""


class PreparedNormalTurn(BaseModel):
    kind: Literal["normal"] = "normal"
    run_id: str
    persona_id: str
    messages: list[dict]  # raw OpenAI wire format — deliberately untyped, out of scope
    referral_handles: dict[str, Referral]
    file_handles: dict[str, FileEntry]


class PreparedBoundaryTurn(BaseModel):
    kind: Literal["boundary"] = "boundary"
    run_id: str
    persona_id: str
    reply: str
    history: list[ChatMessage]
    meta: TurnMeta


PreparedTurn = PreparedNormalTurn | PreparedBoundaryTurn


class TurnMeta(BaseModel):
    new_contacts: list[ContactOut] = Field(default_factory=list)
    shared_files: list[SharedFileOut] = Field(default_factory=list)
    chat_ended: bool
    chat_end_reason: str | None
    warning_count: int


class DeltaFrame(BaseModel):
    text: str


class DoneFrame(BaseModel):
    reply: str
    history: list[ChatMessage]


class ErrorFrame(BaseModel):
    detail: str


PreparedBoundaryTurn.model_rebuild()
