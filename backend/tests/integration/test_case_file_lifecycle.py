"""DB-backed tests for services/cases.py's Option-1 file-lifecycle cleanup:
extractFileIds/fileStillReferenced/deleteOrphanedFiles, wired into deleteCase and
updateCase. Genuinely Postgres-specific (fileStillReferenced searches the real
`cases.structure` JSONB across every case), like test_case_file_dedup.py's dedup
tests it sits alongside.

Every test here also exercises infra.spaces.deleteObject for real (a DELETE against
the configured Spaces bucket for a made-up object_key) — harmless and idempotent
(S3-compatible DELETE 204s on a key that was never uploaded), same as
test_case_file_dedup.py already exercises real Postgres writes.
"""

import uuid
from sqlmodel import select
from infra.db_models import File
from services import cases as case_service
from tests.factories import asCurrentAdmin, createPayload, fileEntry, persona, updatePayload


def uniqueObjectKey() -> str:
    return f"cases/test/{uuid.uuid4().hex}.pdf"


def photoRef(object_key: str) -> dict:
    return {"file_id": None, "object_key": object_key, "file_name": "photo.png", "content_type": "image/png"}


async def test_deleting_a_case_deletes_its_unshared_files(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    created = await case_service.createCase(
        session, createPayload(personas=[persona("A", files=[fileEntry(object_key=object_key)])], roots=["A"]), owner
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert len(rows) == 1

    await case_service.deleteCase(session, case_id, owner)

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert rows == []


async def test_deleting_a_case_does_not_delete_a_file_still_used_by_another_case(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    first = await case_service.createCase(
        session, createPayload(personas=[persona("A", files=[fileEntry(object_key=object_key)])], roots=["A"]), owner
    )
    cleanup.track_case(first.case_id)
    second = await case_service.createCase(
        session, createPayload(personas=[persona("A", files=[fileEntry(object_key=object_key)])], roots=["A"]), owner
    )
    cleanup.track_case(second.case_id)

    await case_service.deleteCase(session, second.case_id, owner)

    # The first case still references the same (deduped) File row — it must survive.
    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert len(rows) == 1


async def test_updating_a_case_to_drop_a_photo_deletes_the_now_unreferenced_file(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    created = await case_service.createCase(
        session, createPayload(personas=[persona("A", profile_photo=photoRef(object_key))], roots=["A"]), owner
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    await case_service.updateCase(
        session,
        case_id,
        updatePayload(1, personas=[persona("A", profile_photo=None)], roots=["A"]),
        owner,
    )

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert rows == []


async def test_updating_a_case_to_drop_a_photo_still_used_elsewhere_keeps_the_file(session, cleanup):
    owner = asCurrentAdmin(await cleanup.make_admin())
    object_key = uniqueObjectKey()

    created = await case_service.createCase(
        session,
        createPayload(
            personas=[
                persona("A", profile_photo=photoRef(object_key)),
                persona("B", profile_photo=photoRef(object_key)),
            ],
            roots=["A", "B"],
        ),
        owner,
    )
    case_id = created.case_id
    cleanup.track_case(case_id)

    # Persona A drops the photo; persona B (same case) keeps it.
    await case_service.updateCase(
        session,
        case_id,
        updatePayload(
            1,
            personas=[persona("A", profile_photo=None), persona("B", profile_photo=photoRef(object_key))],
            roots=["A", "B"],
        ),
        owner,
    )

    rows = (await session.exec(select(File).where(File.object_key == object_key))).all()
    assert len(rows) == 1
