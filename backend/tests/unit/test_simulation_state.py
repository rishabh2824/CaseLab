"""getSimulationState, export, and the SSE producer's
detached-task/client-disconnect contract.
"""

import asyncio

import pytest
from domain_errors import RunNotFound
from services.simulation.state import exportSimulation, getSimulationState
from services.simulation.stream import generations, streamTurn

from tests import factories


async def test_get_simulation_state_on_unknown_run_raises_run_not_found(sim):
    # Needs the `sim` fixture even though it never sets up a case: without it,
    # getRun falls through to the real DB-backed run_store instead of the
    # in-memory fake, which is slow and not hermetic.
    with pytest.raises(RunNotFound):
        await getSimulationState("no-such-run")


async def test_export_orders_roots_then_referred_by_unlock_time(sim):
    # roots sort alphabetically by name (Alice, Bob); referred personas
    # should follow in the order they were actually unlocked, not the order
    # their referrals were authored in the case structure.
    structure = factories.caseStructure(
        personas=[
            factories.persona("A", name="Alice"),
            factories.persona("B", name="Bob"),
            factories.persona("C", name="Carl"),
            factories.persona("D", name="Dana"),
        ],
        referrals=[
            factories.referral("A", "C", "unlock Carl"),
            factories.referral("B", "D", "unlock Dana"),
        ],
        roots=["A", "B"],
    )
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id

    sim.llm.referral = True
    sim.llm.replyWith("Meet Carl.", introduce=["R1"])
    await sim.send(run_id, "A", "hi")  # unlocks C first

    sim.store.shiftStart(run_id, 5)  # make the second unlock strictly later

    sim.llm.replyWith("Meet Dana.", introduce=["R1"])
    await sim.send(run_id, "B", "hi")  # unlocks D second

    sim.llm.replyWith("Hello, I'm Carl.")
    await sim.send(run_id, "C", "hi Carl")  # D is left never-messaged

    export = await exportSimulation(run_id)

    assert [p.id for p in export.personas] == ["A", "B", "C", "D"]
    carl = next(p for p in export.personas if p.id == "C")
    dana = next(p for p in export.personas if p.id == "D")
    assert [m.role for m in carl.messages] == ["user", "assistant"]
    assert dana.messages == []  # unlocked but never messaged


async def test_stream_message_for_boundary_turn_never_touches_the_llm(sim):
    structure = factories.caseStructure(personas=[factories.persona("A")], roots=["A"])
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"

    prepared = await sim.prepare(run_id, "A", "bad message")
    frames = []
    async for frame in streamTurn(prepared):
        frames.append(frame["event"])

    assert frames == ["meta", "delta", "done"]
    assert sim.llm.replyCalls == []


async def test_client_disconnect_does_not_lose_the_reply(sim):
    # streamTurn's normal-turn branch runs `generateReply()` as a detached task
    # referenced only by the module-level `generations` set, specifically so
    # that a client disconnecting mid-stream (closing the SSE generator)
    # doesn't cancel generation. Nothing previously verified this — this
    # drains only the first frame, closes the generator early, and checks
    # the reply still lands in the run blob.
    structure = factories.caseStructure(personas=[factories.persona("A")], roots=["A"])
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.replyWith("Persisted despite disconnect.")

    prepared = await sim.prepare(run_id, "A", "hello")
    gen = streamTurn(prepared)
    await gen.__anext__()  # consume exactly one frame, like a reader that stops early

    # Grab whatever producer task is still tracked before we close the
    # generator — it may already be done (this stub LLM has no real
    # awaits), which is fine; either way the assertion below must hold.
    outstanding = list(generations)
    await gen.aclose()
    if outstanding:
        await asyncio.gather(*outstanding)

    raw_history = sim.store.raw(run_id)["history"]["A"]
    assert {"role": "assistant", "content": "Persisted despite disconnect."} in raw_history
