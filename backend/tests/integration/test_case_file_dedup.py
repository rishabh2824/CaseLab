"""DB-backed tests for services/cases.py::resolveFileRef and the
access-code uniqueness Postgres actually enforces.

Both are genuinely Postgres-specific: resolveFileRef's dedup only works
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
from infra.db import getSession
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
    # resolveFileRef must resolve them to the exact same files row.
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
    # persona. If resolveFileRef inserted instead of reusing, this would
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
    # start (see resolveFileRef's comment) avoids an int-vs-str mismatch.
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


# Regression test for a race where two concurrent creates with the same
# access_code could both pass accessCodeTaken()'s READ COMMITTED precheck
# and then race into the real unique-index-enforced INSERT. createCase (and
# updateCase, which has the same shape) now wrap that write in exception
# handling too, so the loser gets a proper AccessCodeConflict (409) instead
# of a raw sqlalchemy.exc.IntegrityError leaking out as a 500. Reproduced
# deterministically here (not left to asyncio scheduling luck) by holding one
# transaction's INSERT open so the second create's precheck can't see it and
# is forced into the real DB-level race.
async def test_create_case_leaks_a_raw_integrity_error_when_a_race_slips_past_the_precheck(cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    code = f"race-{uuid.uuid4().hex[:8]}"

    async with getSession() as holder_session:
        # Insert-but-don't-commit a case with this access code: the row lock
        # is held, but the row is invisible to any other session (READ
        # COMMITTED), which is exactly the window accessCodeTaken()'s precheck
        # can't defend against.
        holder = Case(name="Holder", brief="brief", access_code=code, admin=owner.id, structure={})
        holder_session.add(holder)
        await holder_session.flush()
        cleanup.track_case(holder.id)

        async def loserCreate():
            async with getSession() as session:
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
