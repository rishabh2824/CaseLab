"""The core turn lifecycle: message() preparing a generation request, and
streamMessage()/reply() driving it to completion and persisting the result.
"""

import pytest
from domain_errors import InvalidRequest, UpstreamError
from services.simulation.service import HISTORY_MESSAGE_LIMIT, MESSAGE_WORDS, getSimulationState

from tests import factories


def singlePersonaCase(**persona_overrides):
    return factories.caseStructure(personas=[factories.persona("A", **persona_overrides)], roots=["A"])


async def test_message_prepares_a_normal_turn_with_cached_system_prompt(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    run_id = state["run_id"]

    prepared = await sim.prepare(run_id, "A", "What vendor do we use?")

    assert prepared["kind"] == "normal"
    system = prepared["messages"][0]
    assert system["role"] == "system"
    # The stable half (case + persona facts) is cached; the per-turn half
    # (referral/file offers, which change every message) is not.
    assert system["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert "cache_control" not in system["content"][1]
    # The rest of the payload is the recent history, which for a first
    # message is just the user's own turn.
    assert prepared["messages"][1:] == [{"role": "user", "content": "What vendor do we use?"}]


async def test_send_streams_delta_then_meta_then_done_and_persists_reply(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    run_id = state["run_id"]
    sim.llm.replyWith("Our vendor is Acme.")

    frames = await sim.send(run_id, "A", "What vendor do we use?")

    assert [name for name, _ in frames] == ["delta", "meta", "done"]
    assert sim.deltas(frames) == "Our vendor is Acme."
    done = sim.frame(frames, "done")
    assert done["history"] == [
        {"role": "user", "content": "What vendor do we use?"},
        {"role": "assistant", "content": "Our vendor is Acme."},
    ]
    assert sim.store.raw(run_id)["history"]["A"][-1] == {"role": "assistant", "content": "Our vendor is Acme."}


async def test_history_window_limits_what_reaches_the_llm_but_not_what_is_persisted(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    run_id = state["run_id"]

    # Four full turns -> 8 history entries (4 user + 4 assistant).
    for i in range(1, 5):
        sim.llm.replyWith(f"reply-{i}")
        await sim.send(run_id, "A", f"turn-{i}")

    # A 5th turn pushes decision_history (this persona's history *including*
    # the just-appended 5th user message) to 9 entries.
    sim.llm.replyWith("reply-5")
    await sim.send(run_id, "A", "turn-5")

    sent_to_llm = sim.llm.replyCalls[-1]
    # system + HISTORY_MESSAGE_LIMIT trailing messages, never the whole thing.
    assert len(sent_to_llm) == 1 + HISTORY_MESSAGE_LIMIT
    # The oldest message still in the window is assistant reply-2 (of the 9
    # pre-reply messages u1,a1,u2,a2,u3,a3,u4,a4,u5, the last 6 start there).
    assert sent_to_llm[1] == {"role": "assistant", "content": "reply-2"}
    assert sent_to_llm[-1] == {"role": "user", "content": "turn-5"}

    # But the full history is still what's returned to the client and persisted.
    full_state = await getSimulationState(run_id)
    assert len(full_state["histories"]["A"]) == 10
    assert len(sim.store.raw(run_id)["history"]["A"]) == 10


async def test_empty_or_whitespace_message_is_rejected(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "A", "   ")


async def test_message_over_word_limit_is_rejected(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    too_long = " ".join(["word"] * (MESSAGE_WORDS + 1))
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "A", too_long)


async def test_unknown_persona_id_is_rejected(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "does-not-exist", "hi")


async def test_persona_present_in_graph_but_not_yet_unlocked_is_rejected(sim):
    structure = factories.caseStructure(
        personas=[factories.persona("A"), factories.persona("B")],
        referrals=[factories.referral("A", "B", "the user asks for B")],
        roots=["A"],
    )
    sim.setCase(structure=structure)
    state = await sim.start()
    # B exists in the persona graph (as a referral target of A) but nothing
    # has unlocked it yet.
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "B", "hi")


async def test_message_after_simulation_duration_is_rejected(sim):
    sim.setCase(structure=singlePersonaCase(), duration=10)
    state = await sim.start()
    sim.store.shiftStart(state["run_id"], 15)
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "A", "hi")


async def test_message_after_persona_availability_expires_is_rejected(sim):
    sim.setCase(structure=singlePersonaCase(availability_minutes=5))
    state = await sim.start()
    sim.store.shiftStart(state["run_id"], 10)
    with pytest.raises(InvalidRequest):
        await sim.prepare(state["run_id"], "A", "hi")


async def test_clean_reply_strips_leading_speaker_tag_before_storing(sim):
    sim.setCase(structure=singlePersonaCase(name="Mary", role="CFO"))
    state = await sim.start()
    run_id = state["run_id"]
    sim.llm.replyWith("[Mary, CFO] Our budget is tight.")

    frames = await sim.send(run_id, "A", "How is the budget?")

    done = sim.frame(frames, "done")
    assert done["reply"] == "Our budget is tight."
    assert sim.store.raw(run_id)["history"]["A"][-1]["content"] == "Our budget is tight."


async def test_empty_reply_emits_error_and_does_not_append_assistant_turn(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    run_id = state["run_id"]
    sim.llm.replyWith("")  # model produced nothing usable

    frames = await sim.send(run_id, "A", "hi")

    assert sim.frame(frames, "error") is not None
    assert sim.frame(frames, "done") is None
    # The user's turn is recorded, but no assistant turn was ever appended.
    history = sim.store.raw(run_id)["history"]["A"]
    assert [m["role"] for m in history] == ["user"]


async def test_reply_stream_failure_emits_error_and_preserves_the_users_turn(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()
    run_id = state["run_id"]
    sim.llm.replyError = RuntimeError("upstream blew up")

    frames = await sim.send(run_id, "A", "hi")

    assert sim.frame(frames, "error") is not None
    assert sim.frame(frames, "done") is None
    # Recorded BEFORE generation (start_turn commits it before the LLM is
    # ever called), so a failed generation cannot lose the user's message.
    history = sim.store.raw(run_id)["history"]["A"]
    assert [m["role"] for m in history] == ["user"]
    assert history[0]["content"] == "hi"


async def test_harassment_classifier_failure_raises_upstream_error(sim):
    sim.setCase(structure=singlePersonaCase())
    state = await sim.start()

    def boom(_message, _history):
        raise RuntimeError("classifier is down")

    sim.llm.harassment = boom

    with pytest.raises(UpstreamError):
        await sim.prepare(state["run_id"], "A", "hi")
