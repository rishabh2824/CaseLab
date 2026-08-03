"""Hermetic harness for the simulation runtime.

`services/simulation/` is the largest and most intricate part of the backend
and had no tests at all, because every entry point reaches a database, an LLM,
and Spaces. This file patches exactly those three seams and nothing else, so a
unit test drives the *real* service, prompt, turn-state and reads code — start
to finish, including the SSE producer — in milliseconds.

What is faked, and why:

* the run store  — an in-memory dict standing in for the `simulations` table.
  `updateRun`'s read-modify-write contract is preserved, so the mutate
  functions in service.py run exactly as they do in production.
* `reads.fetchCase` — returns a `Case` built in memory. Deliberately patched
  *below* `getCase`/`buildPersonaGraph` so `caseSnapshot`, `CaseStructure`
  validation and `flattenPersonas` are all still under test.
* the LLM — `StubLlm` below, which is programmable per test and records every
  call, so a test can assert on what the classifier was actually asked.
* rate limits and Spaces URL signing — patched away; they have their own tests.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any
from collections.abc import Callable

import pytest
from infra.db_models import Case
from models.cases import CaseStructure
from models.simulations import SendMessagePayload, StartSimulationPayload
from services.simulation import prompt as prompt_module
from services.simulation import reads as reads_module
from services.simulation import service as sim_service

from tests import factories


# --------------------------------------------------------------------------
# in-memory run store
# --------------------------------------------------------------------------


class FakeRunStore:
    """Stands in for services/simulation/run_store.py.

    Stores each run as a JSON round-trip of the real serialized form, which is
    what catches the class of bug the real store exists to prevent: a set that
    silently becomes a list, or an int dict key that comes back as a string,
    once the blob has been through JSONB.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    async def insert(self, run_id: str, run: dict) -> None:
        self.rows[run_id] = self._roundTrip(run)

    async def get(self, run_id: str) -> dict:
        from domain_errors import RunNotFound

        if run_id not in self.rows:
            raise RunNotFound(f"Run {run_id} not found.")
        return self._deserialize(self.rows[run_id])

    async def update(self, run_id: str, fn: Callable[[dict], Any]) -> Any:
        from domain_errors import RunNotFound

        if run_id not in self.rows:
            raise RunNotFound(f"Run {run_id} not found.")
        run = self._deserialize(self.rows[run_id])
        result = fn(run)
        self.rows[run_id] = self._roundTrip(run)
        return result

    # -- helpers ----------------------------------------------------------

    @staticmethod
    def _roundTrip(run: dict) -> dict:
        from services.simulation.run_store import serializeRun

        return json.loads(json.dumps(serializeRun(run)))

    @staticmethod
    def _deserialize(data: dict) -> dict:
        from services.simulation.run_store import deserializeRun

        return deserializeRun(data)

    # -- test affordances -------------------------------------------------

    def raw(self, run_id: str) -> dict:
        """The stored (serialized) blob, for asserting on persistence."""
        return self.rows[run_id]

    def shiftStart(self, run_id: str, minutes: float) -> None:
        """Move a run's start_time backwards so `elapsedMinutes` reports
        `minutes` elapsed — deterministic, and without freezing the clock for
        everything else in the process."""
        self.rows[run_id]["start_time"] -= minutes * 60


# --------------------------------------------------------------------------
# programmable LLM stub
# --------------------------------------------------------------------------


class StubLlm:
    """Every LLM call the simulation makes, made deterministic.

    Each hook accepts either a constant or a callable, so a test can express
    "always unlock" as `stub_llm.referral = True` and "unlock only once the
    user mentions the budget" as a lambda over the condition and history.
    """

    def __init__(self) -> None:
        self.harassment: str | Callable[[str, list[dict]], str] = "normal"
        self.referral: bool | Callable[[str, list[dict]], bool] = False
        self.fileShare: bool | Callable[[str, list[dict]], bool] = False
        # Events yielded by personaReplyStream, in order. The default is a
        # plain reply with no tool call.
        self.replyEvents: list[dict] | Callable[[list[dict]], list[dict]] = [
            {"type": "delta", "text": "Hello there."},
            {"type": "tool_call", "arguments": None},
        ]
        # Raised by personaReplyStream instead of yielding, if set.
        self.replyError: Exception | None = None

        self.harassmentCalls: list[tuple[str, list[dict]]] = []
        self.referralCalls: list[tuple[str, list[dict]]] = []
        self.fileShareCalls: list[tuple[str, list[dict]]] = []
        self.replyCalls: list[list[dict]] = []

    @staticmethod
    def _resolve(value, *args):
        return value(*args) if callable(value) else value

    async def classifyHarassment(self, user_message: str, conversation: list[dict]) -> str:
        self.harassmentCalls.append((user_message, conversation))
        return self._resolve(self.harassment, user_message, conversation)

    async def classifyReferral(self, condition: str, conversation: list[dict]) -> bool:
        self.referralCalls.append((condition, conversation))
        return self._resolve(self.referral, condition, conversation)

    async def classifyFileShare(self, condition: str, conversation: list[dict]) -> bool:
        self.fileShareCalls.append((condition, conversation))
        return self._resolve(self.fileShare, condition, conversation)

    async def personaReplyStream(self, messages: list[dict]):
        self.replyCalls.append(messages)
        if self.replyError is not None:
            raise self.replyError
        for event in self._resolve(self.replyEvents, messages):
            yield event

    # -- convenience ------------------------------------------------------

    def replyWith(self, text: str, *, introduce: list[str] | None = None, send_files: list[str] | None = None) -> None:
        """Reply `text` and report the given handles via the metadata tool."""
        arguments = None
        if introduce is not None or send_files is not None:
            arguments = {"introduce": introduce or [], "send_files": send_files or []}
        self.replyEvents = [
            {"type": "delta", "text": text},
            {"type": "tool_call", "arguments": arguments},
        ]

    @property
    def lastSystemPrompt(self) -> str:
        """The full system text of the most recent reply call — the cached
        stable half and the per-turn half concatenated."""
        system = self.replyCalls[-1][0]
        return "\n".join(block["text"] for block in system["content"])


# --------------------------------------------------------------------------
# the composed harness
# --------------------------------------------------------------------------


class SimHarness:
    """Drives whole simulation turns against the patched seams."""

    def __init__(self, store: FakeRunStore, llm: StubLlm) -> None:
        self.store = store
        self.llm = llm
        self.case: Case | None = None

    def setCase(
        self,
        structure: CaseStructure | None = None,
        *,
        case_id: int = 1,
        case_name: str = "Sterling Industries",
        brief: str = "Reduce office supply costs.",
        common_information: str | None = "Company background.",
        duration: int | None = 45,
        access_code: str | None = "STERLING",
    ) -> Case:
        structure = structure if structure is not None else factories.caseStructure()
        self.case = Case(
            id=case_id,
            name=case_name,
            brief=brief,
            common_information=common_information,
            duration=duration,
            root_personas=len(structure.roots),
            access_code=access_code,
            admin=1,
            structure=structure.model_dump(mode="json"),
            version=1,
        )
        return self.case

    async def start(self, access_code: str = "STERLING") -> dict:
        return await sim_service.startSimulation(StartSimulationPayload(access_code=access_code))

    async def prepare(self, run_id: str, persona_id: str, text: str) -> dict:
        return await sim_service.message(
            run_id, SendMessagePayload(persona_id=persona_id, message=text)
        )

    async def send(self, run_id: str, persona_id: str, text: str) -> list[tuple[str, dict]]:
        """A full turn: prepare it, drive the SSE generator to completion, and
        return the decoded `(event, data)` frames in the order the browser
        would have received them."""
        prepared = await self.prepare(run_id, persona_id, text)
        frames: list[tuple[str, dict]] = []
        async for frame in sim_service.streamMessage(prepared):
            frames.append((frame["event"], json.loads(frame["data"])))
        return frames

    @staticmethod
    def frame(frames: list[tuple[str, dict]], event: str) -> dict | None:
        for name, data in frames:
            if name == event:
                return data
        return None

    @staticmethod
    def deltas(frames: list[tuple[str, dict]]) -> str:
        return "".join(data.get("text", "") for name, data in frames if name == "delta")


@pytest.fixture
def fake_run_store(monkeypatch) -> FakeRunStore:
    store = FakeRunStore()
    monkeypatch.setattr(sim_service, "insertRun", store.insert)
    monkeypatch.setattr(sim_service, "getRun", store.get)
    monkeypatch.setattr(sim_service, "updateRun", store.update)
    return store


@pytest.fixture
def stub_llm(monkeypatch) -> StubLlm:
    llm = StubLlm()
    monkeypatch.setattr(sim_service, "classifyHarassment", llm.classifyHarassment)
    monkeypatch.setattr(sim_service, "personaReplyStream", llm.personaReplyStream)
    # referralUnlock/fileShare call these through the prompt module's namespace.
    monkeypatch.setattr(prompt_module, "classifyReferral", llm.classifyReferral)
    monkeypatch.setattr(prompt_module, "classifyFileShare", llm.classifyFileShare)
    return llm


@pytest.fixture
def no_rate_limit(monkeypatch):
    async def allow(_key: str) -> None:
        return None

    monkeypatch.setattr(sim_service, "messageLimit", allow)
    monkeypatch.setattr(sim_service, "simulationLimit", allow)


@pytest.fixture
def fake_spaces(monkeypatch):
    """Deterministic, offline stand-in for presigned Spaces URLs."""

    def getUrl(object_key: str) -> str:
        return f"https://spaces.test/{object_key}?signed=1"

    monkeypatch.setattr(reads_module, "getUrl", getUrl)
    monkeypatch.setattr(sim_service, "getUrl", getUrl)
    return getUrl


@pytest.fixture
def sim(monkeypatch, fake_run_store, stub_llm, no_rate_limit, fake_spaces) -> SimHarness:
    harness = SimHarness(fake_run_store, stub_llm)
    harness.setCase()

    @asynccontextmanager
    async def noSession():
        # startSimulation opens a session purely to hand to fetchCase, which is
        # patched below — nothing downstream ever uses the object itself.
        yield None

    async def fetchCase(_session, *, case_id: int | None = None, access_code: str | None = None):
        from domain_errors import CaseNotFound

        case = harness.case
        if case is None:
            raise CaseNotFound("No case configured for this test.")
        if case_id is not None and case_id != case.id:
            return None
        if access_code is not None and (case.access_code or "").strip() != access_code.strip():
            return None
        return case

    monkeypatch.setattr(sim_service, "getSession", noSession)
    monkeypatch.setattr(reads_module, "getSession", noSession)
    monkeypatch.setattr(reads_module, "fetchCase", fetchCase)
    return harness
