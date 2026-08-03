"""startSimulation / getSimulationState: entry-point validation and the
contract that nothing persona-secret ever reaches the browser.
"""

import pytest
from domain_errors import CaseNotFound, InvalidRequest
from services.simulation import service as sim_service

from tests import factories


SECRET_FIELDS = ("known_facts", "personality_traits", "files")


def freezeElapsed(monkeypatch, minutes: float) -> None:
    """Make `elapsedMinutes` report `minutes` have passed by the time
    startSimulation picks the initial `active_persona_id` — this happens
    synchronously before the run is ever written to the store, so
    `sim.store.shiftStart` (which mutates an already-persisted row) can't
    reach it. Patches the real stdlib `time.time`, which every caller reads
    fresh by attribute lookup, so both `services.simulation.service` and
    `services.simulation.turn_state` see the same fake clock.
    """
    base = 1_700_000_000.0
    calls = {"n": 0}

    def fake_time():
        calls["n"] += 1
        # First call captures start_time; every call after reports `minutes` elapsed.
        return base if calls["n"] == 1 else base + minutes * 60

    monkeypatch.setattr("time.time", fake_time)


async def test_blank_access_code_rejected_before_any_lookup(sim, monkeypatch):
    # Guards against blank codes ever reaching the rate limiter or a DB lookup.
    calls = []

    async def record(code):
        calls.append(code)

    monkeypatch.setattr(sim_service, "simulationLimit", record)

    with pytest.raises(InvalidRequest):
        await sim.start("   ")
    assert calls == []


async def test_unknown_access_code_raises_case_not_found(sim):
    with pytest.raises(CaseNotFound):
        await sim.start("NOT-A-REAL-CODE")


async def test_case_with_no_root_personas_raises_invalid_request(sim):
    structure = factories.caseStructure(personas=[factories.persona("A")], roots=[])
    sim.setCase(structure=structure)
    with pytest.raises(InvalidRequest):
        await sim.start()


async def test_successful_start_returns_trimmed_summary_and_one_contact_per_root(sim):
    structure = factories.caseStructure(
        personas=[factories.persona("A", name="Alice"), factories.persona("B", name="Bob")],
        roots=["A", "B"],
    )
    sim.setCase(
        structure=structure,
        case_id=7,
        case_name="Acme Case",
        brief="Do the thing.",
        common_information="Internal only.",
        duration=30,
        access_code="ACME",
    )

    state = await sim.start("ACME")

    # Case summary is trimmed: no access_code, no common_information.
    assert state["case"] == {
        "id": 7,
        "case_name": "Acme Case",
        "initial_brief": "Do the thing.",
        "simulation_duration": 30,
    }
    assert len(state["contacts"]) == 2
    assert {c.id for c in state["contacts"]} == {"A", "B"}
    assert state["histories"] == {}
    assert state["shared_files"] == []
    assert state["notes"] == ""
    assert state["run_id"] in sim.store.rows


async def test_secrets_never_reach_the_browser(sim):
    # This is the single most important assertion in this file: known_facts,
    # personality_traits and files are the LLM's persona secrets / unlock
    # answer keys and must never be serialized into a contact.
    structure = factories.caseStructure(
        personas=[
            factories.persona(
                "A",
                known_facts="The budget is $2M.",
                personality_traits="Blunt, impatient.",
                files=[factories.fileEntry()],
            )
        ],
        roots=["A"],
    )
    sim.setCase(structure=structure)

    # ContactOut (models/simulations.py) has no known_facts/personality_traits/
    # files fields at all — the leak class this test guards against is now
    # structurally impossible, not just conventionally avoided, but the
    # runtime check is kept as a concrete regression guard.
    start_state = await sim.start()
    for contact in start_state["contacts"]:
        for field in SECRET_FIELDS:
            assert not hasattr(contact, field), f"{field} leaked into startSimulation contact"

    state = await sim_service.getSimulationState(start_state["run_id"])
    for contact in state["contacts"]:
        for field in SECRET_FIELDS:
            assert not hasattr(contact, field), f"{field} leaked into getSimulationState contact"


async def test_root_with_closed_availability_window_excluded_from_active_persona(sim, monkeypatch):
    # Alice's window closes at minute 5; Bob has no window. If the clock has
    # already passed Alice's window by the time the run is created, she must
    # not become the default active contact even though she sorts first.
    structure = factories.caseStructure(
        personas=[
            factories.persona("A", name="Alice", availability_minutes=5),
            factories.persona("B", name="Bob"),
        ],
        roots=["A", "B"],
    )
    sim.setCase(structure=structure)
    freezeElapsed(monkeypatch, 10)

    state = await sim.start()

    alice = next(c for c in state["contacts"] if c.id == "A")
    bob = next(c for c in state["contacts"] if c.id == "B")
    assert alice.available is False
    assert bob.available is True
    assert state["active_persona_id"] == "B"


async def test_profile_photos_are_resigned_via_spaces(sim, fake_spaces):
    structure = factories.caseStructure(
        personas=[
            factories.persona(
                "A",
                profile_photo={
                    "file_id": "photo-1",
                    "object_key": "cases/1/alice.png",
                    "file_name": "alice.png",
                    "content_type": "image/png",
                },
            )
        ],
        roots=["A"],
    )
    sim.setCase(structure=structure)

    state = await sim.start()

    photo = state["contacts"][0].profile_photo
    assert photo.url == fake_spaces("cases/1/alice.png")


async def test_rate_limiter_is_consulted_with_the_trimmed_access_code(sim, monkeypatch):
    calls = []

    async def record(code):
        calls.append(code)

    monkeypatch.setattr(sim_service, "simulationLimit", record)

    await sim.start(" STERLING ")

    assert calls == ["STERLING"]
