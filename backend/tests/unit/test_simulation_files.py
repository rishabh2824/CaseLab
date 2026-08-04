"""File sharing: offering, withholding, and applying shares."""

from services.simulation import service as sim_service

from tests import factories


def caseWithOneFile(**file_overrides):
    defaults = dict(
        file_id="1",
        object_key="cases/1/budget.pdf",
        file_name="budget.pdf",
        share_conditions="the user asks about the budget",
        perceived_contents="Q3 numbers",
    )
    defaults.update(file_overrides)
    file_entry = factories.fileEntry(**defaults)
    return factories.caseStructure(personas=[factories.persona("A", files=[file_entry])], roots=["A"])


async def test_eligible_file_is_offered_and_sending_it_shares_a_signed_url(sim, fake_spaces):
    sim.setCase(structure=caseWithOneFile())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.fileShare = True
    sim.llm.replyWith("Here's the budget.", send_files=["F1"])

    frames = await sim.send(run_id, "A", "Can I see the budget?")

    assert "F1: budget.pdf (what you believe it contains: Q3 numbers)" in sim.llm.lastSystemPrompt
    meta = sim.frame(frames, "meta")
    assert len(meta["shared_files"]) == 1
    shared = meta["shared_files"][0]
    assert shared["file_id"] == "1"
    assert shared["url"] == fake_spaces("cases/1/budget.pdf")
    assert "1" in sim.store.raw(run_id)["shared_files"]


async def test_file_entry_with_no_file_id_is_never_offered_but_is_withheld(sim):
    structure = caseWithOneFile(file_id=None)
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.fileShare = True  # would approve if ever asked
    sim.llm.replyWith("Sure.")

    await sim.send(run_id, "A", "Can I see the budget?")

    # Never classified — there is no file_id to key it by.
    assert sim.llm.fileShareCalls == []
    assert "budget.pdf" in sim.llm.lastSystemPrompt
    assert "must NOT send" in sim.llm.lastSystemPrompt


async def test_file_rejected_by_classifier_is_withheld_and_not_offered(sim):
    sim.setCase(structure=caseWithOneFile())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.fileShare = False
    sim.llm.replyWith("I can't share that.")

    frames = await sim.send(run_id, "A", "Can I see the budget?")

    assert "budget.pdf" in sim.llm.lastSystemPrompt
    assert "must NOT send" in sim.llm.lastSystemPrompt
    meta = sim.frame(frames, "meta")
    assert meta["shared_files"] == []


async def test_already_shared_file_is_not_reoffered_or_duplicated(sim):
    sim.setCase(structure=caseWithOneFile())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.fileShare = True
    sim.llm.replyWith("Here's the budget.", send_files=["F1"])
    await sim.send(run_id, "A", "Can I see the budget?")
    assert len(sim.llm.fileShareCalls) == 1

    # Second turn: the file is already shared, so it must not be re-classified,
    # and the model reporting the (now stale/invalid) handle again must be a no-op.
    sim.llm.replyWith("Anything else?", send_files=["F1"])
    frames = await sim.send(run_id, "A", "Anything else about the budget?")

    assert len(sim.llm.fileShareCalls) == 1  # not classified again
    meta = sim.frame(frames, "meta")
    assert meta["shared_files"] == []
    assert len(sim.store.raw(run_id)["shared_files"]) == 1


async def test_get_simulation_state_returns_shared_files_with_fresh_signed_urls(sim, fake_spaces):
    sim.setCase(structure=caseWithOneFile())
    state = await sim.start()
    run_id = state.run_id
    sim.llm.fileShare = True
    sim.llm.replyWith("Here's the budget.", send_files=["F1"])
    await sim.send(run_id, "A", "Can I see the budget?")

    full_state = await sim_service.getSimulationState(run_id)

    assert len(full_state.shared_files) == 1
    assert full_state.shared_files[0].url == fake_spaces("cases/1/budget.pdf")


async def test_unknown_file_handle_from_model_is_ignored(sim):
    structure = factories.caseStructure(personas=[factories.persona("A", files=[])], roots=["A"])
    sim.setCase(structure=structure)
    state = await sim.start()
    run_id = state.run_id
    sim.llm.replyWith("Sure.", send_files=["F9"])

    frames = await sim.send(run_id, "A", "hi")

    assert sim.frame(frames, "error") is None
    meta = sim.frame(frames, "meta")
    assert meta["shared_files"] == []
