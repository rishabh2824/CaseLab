from __future__ import annotations
import time
from sqlalchemy import CheckConstraint, Column, Index, UniqueConstraint, text
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
    # Mirrors the raw-SQL partial unique index from the 073f33fc20e2 baseline
    # migration exactly (name, columns, WHERE clause). Declared here so
    # SQLAlchemy's metadata knows about it — otherwise `alembic revision
    # --autogenerate` sees an index that exists in the DB but not in the
    # models and proposes dropping it every time (already happened once,
    # see 83a3b6111f69). This declaration must stay byte-for-byte in sync
    # with that CREATE UNIQUE INDEX statement; it does not itself create or
    # alter anything in the database.
    __table_args__ = (
        Index(
            "idx_cases_access_code_unique",
            "access_code",
            unique=True,
            postgresql_where=text("access_code IS NOT NULL AND access_code != ''"),
        ),
    )

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
    start_time: float
    expires_at: float = Field(index=True)
    # Write-once: {case_snapshot, persona_graph}. Set at insertRun, never
    # rewritten by updateRun (see run_store.py).
    snapshot: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    # Small mutable bag: {active_persona_id, unlocked_referred_ids, unlocked_at,
    # shared_files, persona_chat_state}. Rewritten in full on every updateRun.
    state: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))


class RunMessage(SQLModel, table=True):
    __tablename__ = "run_messages"
    # Every read (run_store.py's _loadHistory) is WHERE run_id = ? AND persona_id IN (...)
    # ORDER BY id. A single-column run_id index (the old shape) only serves the filter --
    # Postgres still pulls every message for the run into memory to apply the persona_id
    # filter and the sort. This composite index satisfies filter and sort together, with
    # run_id leading so plain run_id-only lookups (if any) still use it directly.
    __table_args__ = (Index("ix_run_messages_run_id_persona_id_id", "run_id", "persona_id", "id"),)

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(foreign_key="simulations.run_id", ondelete="CASCADE")
    persona_id: str
    role: str
    content: str


class RateLimit(SQLModel, table=True):
    __tablename__ = "rate_limits"

    key: str = Field(primary_key=True)
    start_time: float
    count: int
