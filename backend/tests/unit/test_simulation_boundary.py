"""The harassment/nonsense escalation path: flagged messages short-circuit
generation entirely and accumulate toward ending the chat.
"""

import pytest
from domain_errors import InvalidRequest
from services.simulation.turn_state import NONSENSE_THRESHOLD

from tests import factories


def twoRootsCase():
    return factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")], roots=["A", "B"]
    )


async def test_one_flagged_message_returns_boundary_kind_without_calling_the_llm(sim):
    sim.setCase(structure=twoRootsCase())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"

    frames = await sim.send(run_id, "A", "bad message")

    assert [name for name, _ in frames] == ["meta", "delta", "done"]
    meta = sim.frame(frames, "meta")
    assert meta["warning_count"] == 1
    assert meta["chat_ended"] is False
    assert len([f for f in frames if f[0] == "delta"]) == 1
    assert sim.llm.replyCalls == []  # personaReplyStream is never reached


async def test_escalation_ends_the_chat_at_the_nonsense_threshold(sim):
    sim.setCase(structure=twoRootsCase())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"

    frames = None
    for _ in range(NONSENSE_THRESHOLD):
        frames = await sim.send(run_id, "A", "bad message")

    meta = sim.frame(frames, "meta")
    assert meta["warning_count"] == NONSENSE_THRESHOLD
    assert meta["chat_ended"] is True
    assert meta["chat_end_reason"] == "harassment"
    assert "ending this conversation" in sim.deltas(frames)


async def test_message_to_an_ended_chat_is_rejected(sim):
    sim.setCase(structure=twoRootsCase())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"
    for _ in range(NONSENSE_THRESHOLD):
        await sim.send(run_id, "A", "bad message")

    sim.llm.harassment = "normal"  # even a clean message can't reopen it
    with pytest.raises(InvalidRequest):
        await sim.prepare(run_id, "A", "sorry, can we continue?")


async def test_ending_one_personas_chat_does_not_end_another_persona(sim):
    sim.setCase(structure=twoRootsCase())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"
    for _ in range(NONSENSE_THRESHOLD):
        await sim.send(run_id, "A", "bad message")

    frames = await sim.send(run_id, "B", "bad message")
    meta = sim.frame(frames, "meta")
    assert meta["warning_count"] == 1
    assert meta["chat_ended"] is False


async def test_normal_message_after_a_warning_does_not_reset_the_count(sim):
    sim.setCase(structure=twoRootsCase())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.harassment = "harassment"
    await sim.send(run_id, "A", "bad message")  # warning_count -> 1

    # Policy decision, asserted explicitly: nothing in the normal-message
    # path touches persona_chat_state, so a clean message afterward leaves
    # the warning count exactly where it was rather than clearing it.
    sim.llm.harassment = "normal"
    sim.llm.replyWith("All good, let's continue.")
    frames = await sim.send(run_id, "A", "sorry, here's a real question")

    meta = sim.frame(frames, "meta")
    assert meta["warning_count"] == 1
    assert meta["chat_ended"] is False
