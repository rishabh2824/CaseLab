"""services/simulation/service.py — hydratePersona.

Signing a profile-photo URL is this service's response-building job, not
reads.py's pure persona-graph shaping (see services/simulation/reads.py and
tests/unit/test_reads.py's module docstring) — so these tests live here.
"""

from __future__ import annotations

from models.cases import FileRef
from models.simulation_runtime import PersonaDetail
from services.simulation import service as sim_service


def signedUrl(object_key: str) -> str:
    return f"https://spaces.test/{object_key}?signed=1"


def personaDetail(**overrides):
    base = dict(id="A", name="A", role="Role")
    base.update(overrides)
    return PersonaDetail(**base)


def test_hydrate_persona_resigns_the_photo(monkeypatch):
    monkeypatch.setattr(sim_service, "getUrl", signedUrl)
    persona = personaDetail(
        profile_photo=FileRef(object_key="cases/1/photo.png", file_name="photo.png", content_type="image/png"),
    )
    result = sim_service.hydratePersona(persona)
    assert result.profile_photo_url == signedUrl("cases/1/photo.png")
    assert result.profile_photo.object_key == "cases/1/photo.png"  # original fields preserved
    # Input untouched: no profile_photo_url was set on the original.
    assert persona.profile_photo_url is None


def test_hydrate_persona_returns_persona_untouched_when_no_photo():
    persona = personaDetail(profile_photo=None)
    result = sim_service.hydratePersona(persona)
    assert result is persona


def test_hydrate_persona_does_not_mutate_input(monkeypatch):
    monkeypatch.setattr(sim_service, "getUrl", signedUrl)
    photo = FileRef(object_key="cases/1/photo.png", file_name="photo.png")
    persona = personaDetail(profile_photo=photo)
    sim_service.hydratePersona(persona)
    assert persona.profile_photo is photo
    assert persona.profile_photo_url is None
