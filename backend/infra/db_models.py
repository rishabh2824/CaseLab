from __future__ import annotations
import time
from sqlalchemy import CheckConstraint, Column, UniqueConstraint
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlmodel import Field, SQLModel


class Admin(SQLModel, table=True):
    __tablename__ = "admins"
    __table_args__ = (CheckConstraint("role in (1, 2)", name="ck_admins_role"),)

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    name: str | None = None
    role: int


class Case(SQLModel, table=True):
    __tablename__ = "cases"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    brief: str
    common_information: str | None = None
    duration: int | None = None
    # CITEXT is for enforcing uniqueness in the access codes
    access_code: str | None = Field(default=None, sa_column=Column(CITEXT))
    admin: int = Field(foreign_key="admins.id", index=True)
    structure: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    # Optimistic-concurrency counter: updateCase() only commits when the caller's
    # expected_version still matches this, so two admins saving the same case
    # concurrently can't silently overwrite one another.
    version: int = Field(default=1, sa_column_kwargs={"server_default": "1"})


class Collaborator(SQLModel, table=True):
    __tablename__ = "collaborators"

    case_id: int = Field(foreign_key="cases.id", ondelete="CASCADE", primary_key=True)
    admin_id: int = Field(foreign_key="admins.id", ondelete="CASCADE", primary_key=True, index=True)
    # Epoch seconds, matching SimulationRun.expires_at / RateLimit.start_time.
    # Determines who gets promoted to owner if the case's owner is deleted
    # (services/admin.py::deleteWithCascade promotes the oldest collaborator).
    added_at: float = Field(default_factory=time.time)


class File(SQLModel, table=True):
    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("object_key", name="uq_files_object_key"),)

    id: int | None = Field(default=None, primary_key=True)
    object_key: str
    name: str
    content_type: str | None = None


class SimulationRun(SQLModel, table=True):
    __tablename__ = "simulations"

    run_id: str = Field(primary_key=True)
    case_id: int
    start_time: float
    expires_at: float = Field(index=True)
    # Write-once: {case_snapshot, persona_graph}. Set at insertRun, never
    # rewritten by updateRun (see run_store.py).
    snapshot: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    # Small mutable bag: {active_persona_id, unlocked_referred_ids, unlocked_at,
    # shared_files, persona_chat_state}. Rewritten in full on every updateRun.
    state: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    notes: str = Field(default="", sa_column_kwargs={"server_default": ""})


class RunMessage(SQLModel, table=True):
    __tablename__ = "run_messages"

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(foreign_key="simulations.run_id", ondelete="CASCADE", index=True)
    persona_id: str
    role: str
    content: str


class RateLimit(SQLModel, table=True):
    __tablename__ = "rate_limits"

    key: str = Field(primary_key=True)
    start_time: float
    count: int
