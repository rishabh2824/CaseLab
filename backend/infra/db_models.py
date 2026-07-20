from __future__ import annotations
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
    root_personas: int
    # CITEXT is for enforcing uniqueness in the access codes
    access_code: str | None = Field(default=None, sa_column=Column(CITEXT))
    admin: int = Field(foreign_key="admins.id", index=True)
    structure: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))


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
    expires_at: float = Field(index=True)
    data: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))


class RateLimit(SQLModel, table=True):
    __tablename__ = "rate_limits"

    key: str = Field(primary_key=True)
    start_time: float
    count: int
