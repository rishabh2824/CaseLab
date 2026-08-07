"""services/cases.py::extractFileIds — pure, no DB. The DB-backed orphan-detection/
cleanup behavior it feeds (fileStillReferenced, deleteOrphanedFiles, and their use in
deleteCase/updateCase) is covered in tests/integration/test_case_file_lifecycle.py,
since it needs a real cases table to search across.
"""

from models.cases import PersonaPayload
from services.cases import extractFileIds
from tests import factories


def personaPayload(**overrides) -> PersonaPayload:
    return PersonaPayload(**factories.persona("A", **overrides))


def test_no_personas_yields_no_file_ids():
    assert extractFileIds([]) == set()


def test_persona_with_no_photo_or_files_yields_no_file_ids():
    assert extractFileIds([personaPayload()]) == set()


def test_collects_profile_photo_file_id():
    photo = {"file_id": "7", "object_key": "k", "file_name": "n.png", "content_type": "image/png"}
    assert extractFileIds([personaPayload(profile_photo=photo)]) == {"7"}


def test_collects_attachment_file_ids():
    entries = [factories.fileEntry(file_id="1"), factories.fileEntry(file_id="2", object_key="cases/test/other.pdf")]
    assert extractFileIds([personaPayload(files=entries)]) == {"1", "2"}


def test_ignores_a_file_entry_with_no_file_id_yet():
    # e.g. a brand-new upload that hasn't gone through resolveFileRefs yet.
    entry = factories.fileEntry(file_id=None)
    assert extractFileIds([personaPayload(files=[entry])]) == set()


def test_dedupes_the_same_file_id_shared_across_personas():
    photo = {"file_id": "9", "object_key": "k", "file_name": "n.png", "content_type": "image/png"}
    personas = [
        PersonaPayload(**factories.persona("A", profile_photo=photo)),
        PersonaPayload(**factories.persona("B", profile_photo=photo)),
    ]
    assert extractFileIds(personas) == {"9"}


def test_collects_across_multiple_personas_photos_and_attachments():
    photo_a = {"file_id": "1", "object_key": "a", "file_name": "a.png", "content_type": "image/png"}
    photo_b = {"file_id": "2", "object_key": "b", "file_name": "b.png", "content_type": "image/png"}
    personas = [
        PersonaPayload(**factories.persona("A", profile_photo=photo_a, files=[factories.fileEntry(file_id="3")])),
        PersonaPayload(**factories.persona("B", profile_photo=photo_b)),
    ]
    assert extractFileIds(personas) == {"1", "2", "3"}
