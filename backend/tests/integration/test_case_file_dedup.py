"""DB-backed tests for services/cases.py::resolve_file_ref and the
access-code uniqueness Postgres actually enforces.

Both are genuinely Postgres-specific: resolve_file_ref's dedup only works
because of the `uq_files_object_key` unique constraint (get-or-create over a
real unique index, not application-level bookkeeping), and access-code
collisions are ultimately caught via a CITEXT unique index
(idx_cases_access_code_unique) — sqlstate 23505 — not just app logic.
"""

import asyncio
import uuid

import pytest
from sqlmodel import select
from domain_errors import AccessCodeConflict
from infra.db import get_session
from infra.db_models import Case, File
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload, fileEntry, persona, updatePayload


def uniqueObjectKey() -> str:
    return f"cases/test/{uuid.uuid4().hex}.pdf"


async def test_two_personas_sharing_an_object_key_dedupe_to_one_file_row(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    payload = createPayload(
        personas=[
            persona("A", files=[fileEntry(object_key=object_key)]),
            persona("B", files=[fileEntry(object_key=object_key)]),
        ],
        roots=["A", "B"],
    )
    created = await case_service.createCase(session, payload, owner)
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, owner)
    file_ids = {p["files"][0]["file"]["file_id"] for p in detail["case"]["personas"]}
    # Both personas reference the same object_key, so the get-or-create in
    # resolve_file_ref must resolve them to the exact same files row.
    assert len(file_ids) == 1

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert len(rows) == 1


async def test_saving_the_same_object_key_again_on_update_reuses_the_existing_row(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    created = await case_service.createCase(
        session, createPayload(personas=[persona("A", files=[fileEntry(object_key=object_key)])], roots=["A"]), owner
    )
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    detail = await case_service.getCase(session, case_id, owner)
    original_file_id = detail["case"]["personas"][0]["files"][0]["file"]["file_id"]

    # A later update references the same object_key from a different (new)
    # persona. If resolve_file_ref inserted instead of reusing, this would
    # either duplicate the row or trip uq_files_object_key.
    await case_service.updateCase(
        session,
        case_id,
        updatePayload(
            1,
            personas=[
                persona("A", files=[fileEntry(object_key=object_key)]),
                persona("B", files=[fileEntry(object_key=object_key)]),
            ],
            roots=["A", "B"],
        ),
        owner,
    )

    detail2 = await case_service.getCase(session, case_id, owner)
    file_ids = {p["files"][0]["file"]["file_id"] for p in detail2["case"]["personas"]}
    assert file_ids == {original_file_id}

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert len(rows) == 1


async def test_stored_file_id_is_a_string_even_though_the_column_is_an_int(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    created = await case_service.createCase(
        session, createPayload(personas=[persona("A", files=[fileEntry(object_key=object_key)])], roots=["A"]), owner
    )
    case_id = created["case_id"]
    cleanup.track_case(case_id)

    file_row = (await session.exec(select(File).where(File.object_key == object_key))).one()

    detail = await case_service.getCase(session, case_id, owner)
    stored_file_id = detail["case"]["personas"][0]["files"][0]["file"]["file_id"]

    # files.id is a plain int column, but the JSONB structure stores it
    # stringified — run["shared_files"] elsewhere keys off this value, and
    # JSON always stringifies dict keys, so keeping it a string from the
    # start (see resolve_file_ref's comment) avoids an int-vs-str mismatch.
    assert isinstance(file_row.id, int)
    assert stored_file_id == str(file_row.id)
    assert isinstance(stored_file_id, str)


async def test_duplicate_access_code_on_a_second_case_raises_access_code_conflict(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    code = f"code-{uuid.uuid4().hex[:8]}"

    first = await case_service.createCase(session, createPayload(access_code=code), owner)
    cleanup.track_case(first["case_id"])

    with pytest.raises(AccessCodeConflict):
        await case_service.createCase(session, createPayload(access_code=code), owner)


async def test_access_codes_are_case_insensitive_because_the_column_is_citext(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    code = f"sterling-{uuid.uuid4().hex[:8]}"

    first = await case_service.createCase(session, createPayload(access_code=code.upper()), owner)
    cleanup.track_case(first["case_id"])

    # "STERLING" and "sterling" must collide — access_code is backed by
    # Postgres's CITEXT type, not a plain varchar with app-side lowercasing.
    with pytest.raises(AccessCodeConflict):
        await case_service.createCase(session, createPayload(access_code=code.lower()), owner)


@pytest.mark.xfail(
    reason=(
        "BUG: createCase's except-IntegrityError branch (services/cases.py, "
        "~line 217) only wraps `await session.commit()`. The actual INSERT "
        "happens a few lines earlier in an unwrapped `await session.flush()` "
        "(needed to assign case.id before the collaborator rows). "
        "accessCodeTaken()'s precheck is a plain SELECT under READ COMMITTED, "
        "so it can't see another session's uncommitted row -- two concurrent "
        "creates with the same access_code can both pass it. When Postgres's "
        "real unique index (idx_cases_access_code_unique) then rejects the "
        "second INSERT, the resulting IntegrityError comes out of the "
        "unwrapped flush() call and is never translated to AccessCodeConflict "
        "-- it propagates as a raw sqlalchemy.exc.IntegrityError, which main.py "
        "has no handler for, i.e. a generic 500 instead of the intended 409. "
        "updateCase has the same shape of bug: its access_code-bearing "
        "`await session.execute(sa_update(Case)...)` is likewise not wrapped "
        "in the try/except around commit(). Reproduced deterministically here "
        "(not left to asyncio scheduling luck) by holding one transaction's "
        "INSERT open so the second create's precheck can't see it and is "
        "forced into the real DB-level race."
    ),
    strict=True,
)
async def test_create_case_leaks_a_raw_integrity_error_when_a_race_slips_past_the_precheck(cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    code = f"race-{uuid.uuid4().hex[:8]}"

    async with get_session() as holder_session:
        # Insert-but-don't-commit a case with this access code: the row lock
        # is held, but the row is invisible to any other session (READ
        # COMMITTED), which is exactly the window accessCodeTaken()'s precheck
        # can't defend against.
        holder = Case(name="Holder", brief="brief", root_personas=0, access_code=code, admin=owner.id, structure={})
        holder_session.add(holder)
        await holder_session.flush()
        cleanup.track_case(holder.id)

        async def loserCreate():
            async with get_session() as session:
                try:
                    created = await case_service.createCase(session, createPayload(access_code=code), owner)
                    return "ok", created["case_id"]
                except AccessCodeConflict:
                    return "conflict", None
                except Exception as exc:  # broad on purpose -- this IS the bug under test
                    return f"crashed: {type(exc).__name__}", None

        task = asyncio.create_task(loserCreate())
        # Give the second create's precheck + INSERT a real chance to run and
        # block on the still-open holder transaction before we release it.
        await asyncio.sleep(5)
        await holder_session.commit()

        outcome, loser_case_id = await task
        if outcome == "ok":
            cleanup.track_case(loser_case_id)

        # Expected/desired behaviour: the loser should see AccessCodeConflict,
        # never a raw exception. Currently it sees "crashed: IntegrityError".
        assert outcome == "conflict"
