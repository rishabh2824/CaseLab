"""Referral unlocking: offering, redacting, and applying introductions."""

from services.simulation import service as sim_service

from tests import factories


def caseWithOneReferral(**referral_overrides):
    referral = factories.referral("A", "B", "the user explicitly asks to speak with Bob")
    referral.update(referral_overrides)
    return factories.caseStructure(
        personas=[factories.persona("A", name="Alice"), factories.persona("B", name="Bob", role="Analyst")],
        referrals=[referral],
        roots=["A"],
    )


async def test_eligible_referral_is_offered_and_introducing_it_unlocks_the_contact(sim):
    sim.setCase(structure=caseWithOneReferral())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True
    sim.llm.replyWith("I'll connect you with Bob.", introduce=["R1"])

    frames = await sim.send(run_id, "A", "Can I talk to someone else?")

    assert "R1: Bob (Analyst)" in sim.llm.lastSystemPrompt
    meta = sim.frame(frames, "meta")
    assert len(meta["new_contacts"]) == 1
    new_contact = meta["new_contacts"][0]
    assert new_contact["id"] == "B"
    # Secrets must be stripped from a freshly-unlocked contact exactly like
    # any other contact — this is the same leak class test_simulation_start
    # guards against, just on the unlock path instead of startSimulation.
    for field in ("known_facts", "personality_traits", "files"):
        assert field not in new_contact

    raw = sim.store.raw(run_id)
    assert "B" in raw["unlocked_referred_ids"]
    assert "B" in raw["unlocked_at"]


async def test_rejected_referral_is_withheld_and_redacted_from_prompt_and_history(sim):
    structure = factories.caseStructure(
        personas=[
            factories.persona("A", name="Alice", known_facts="Bob is the analyst who audited the budget."),
            factories.persona("B", name="Bob", role="Analyst"),
        ],
        referrals=[factories.referral("A", "B", "the user explicitly asks to speak with Bob")],
        roots=["A"],
    )
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = False  # classifier never approves this referral

    # Turn 1: the model mentions Bob by name in its reply (nothing stops it
    # from doing so in the raw text — sanitization only protects what gets
    # fed back into the model later).
    sim.llm.replyWith("Let me tell you about Bob.")
    await sim.send(run_id, "A", "Tell me about Bob.")

    # Turn 2: Bob is still forbidden. His name must be scrubbed both from the
    # known_facts baked into this turn's system prompt AND from the prior
    # assistant turn now being replayed back into the model.
    sim.llm.replyWith("Sure, ask away.")
    await sim.send(run_id, "A", "Anything else?")

    prompt = sim.llm.lastSystemPrompt
    assert "Bob" not in prompt
    assert "[undisclosed contact]" in prompt

    sent_messages = sim.llm.replyCalls[-1]
    prior_assistant = next(m for m in sent_messages if m.get("role") == "assistant")
    assert "Bob" not in prior_assistant["content"]
    assert prior_assistant["content"] == "Let me tell you about my contact."

    assert sim.store.raw(run_id)["unlocked_referred_ids"] == []


async def test_unoffered_handle_from_model_unlocks_nothing_and_does_not_crash(sim):
    sim.setCase(structure=caseWithOneReferral())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = False  # so no handle is ever offered this turn
    sim.llm.replyWith("Sure.", introduce=["R9"])  # model hallucinates a handle

    frames = await sim.send(run_id, "A", "hi")

    meta = sim.frame(frames, "meta")
    assert meta["new_contacts"] == []
    assert sim.frame(frames, "done") is not None
    assert sim.store.raw(run_id)["unlocked_referred_ids"] == []


async def test_duplicate_handles_in_one_reply_unlock_the_persona_exactly_once(sim):
    sim.setCase(structure=caseWithOneReferral())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True
    sim.llm.replyWith("Meet Bob.", introduce=["R1", "R1"])

    frames = await sim.send(run_id, "A", "hi")

    meta = sim.frame(frames, "meta")
    assert len(meta["new_contacts"]) == 1


async def test_reunlocking_an_already_unlocked_persona_is_a_noop(sim):
    # Regression guard for a double-submit / retry race: if applyDecisions
    # is ever invoked twice for the same referral (e.g. a client retry after
    # a dropped response), the second call must not duplicate the contact or
    # move its unlock time.
    sim.setCase(structure=caseWithOneReferral())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True

    prepared = await sim.prepare(run_id, "A", "Connect me with Bob please.")
    new_contacts_1, *_ = await sim_service.applyDecisions(run_id, prepared, ["R1"], [], "A", "Sure, meet Bob.")
    assert len(new_contacts_1) == 1
    first_unlocked_at = sim.store.raw(run_id)["unlocked_at"]["B"]

    sim.store.shiftStart(run_id, 5)  # time passes before the (simulated) retry

    new_contacts_2, *_ = await sim_service.applyDecisions(
        run_id, prepared, ["R1"], [], "A", "Sure, meet Bob again."
    )
    assert new_contacts_2 == []
    assert sim.store.raw(run_id)["unlocked_at"]["B"] == first_unlocked_at


async def test_unlocked_persona_is_messageable_and_state_marks_it_referred(sim):
    sim.setCase(structure=caseWithOneReferral())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True
    sim.llm.replyWith("Meet Bob.", introduce=["R1"])
    await sim.send(run_id, "A", "hi")

    sim.llm.replyWith("Hi, I'm Bob.")
    frames = await sim.send(run_id, "B", "Hello Bob")
    assert sim.frame(frames, "error") is None

    full_state = await sim_service.getSimulationState(run_id)
    bob_contact = next(c for c in full_state.contacts if c.id == "B")
    assert bob_contact.is_referred is True


async def test_persona_referred_by_two_parents_stops_being_pending_for_the_other(sim):
    structure = factories.caseStructure(
        personas=[
            factories.persona("A", name="Alice"),
            factories.persona("D", name="Dana"),
            factories.persona("B", name="Bob", role="Analyst"),
        ],
        referrals=[
            factories.referral("A", "B", "the user asks A about Bob"),
            factories.referral("D", "B", "the user asks Dana about Bob"),
        ],
        roots=["A", "D"],
    )
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True
    sim.llm.replyWith("Meet Bob.", introduce=["R1"])
    await sim.send(run_id, "A", "hi")  # unlocks B via A

    calls_before = len(sim.llm.referralCalls)
    prepared = await sim.prepare(run_id, "D", "hi")
    # B is no longer pending for D — nothing to offer, and nothing to classify.
    assert prepared.referral_handles == {}
    assert len(sim.llm.referralCalls) == calls_before


async def test_handle_numbering_is_stable_and_one_indexed_across_referrals(sim):
    structure = factories.caseStructure(
        personas=[
            factories.persona("A", name="Alice"),
            factories.persona("B", name="Bob"),
            factories.persona("C", name="Carl"),
            factories.persona("E", name="Erin"),
        ],
        referrals=[
            factories.referral("A", "B", "cond 1"),
            factories.referral("A", "C", "cond 2"),
            factories.referral("A", "E", "cond 3"),
        ],
        roots=["A"],
    )
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.referral = True

    prepared = await sim.prepare(run_id, "A", "hi")

    handles = prepared.referral_handles
    assert set(handles) == {"R1", "R2", "R3"}
    assert handles["R1"].referred_persona_id == "B"
    assert handles["R2"].referred_persona_id == "C"
    assert handles["R3"].referred_persona_id == "E"
