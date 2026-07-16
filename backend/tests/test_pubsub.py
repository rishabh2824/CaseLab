"""infra.pubsub: disabled-by-default behavior, and best-effort publish semantics."""

import pytest

from infra import pubsub


@pytest.fixture(autouse=True)
def _reset_client_cache():
    # _client() is lru_cached across the whole test run; without this, whichever
    # test runs first would pin its settings.redis_url for every test after it.
    pubsub._client.cache_clear()
    yield
    pubsub._client.cache_clear()


class TestUnconfigured:
    """No REDIS_URL (the default, per conftest) — every entry point must be a no-op."""

    async def test_publish_does_not_raise(self):
        await pubsub.publish_run_update("run1")  # would raise if it tried to connect

    async def test_subscribe_yields_none(self):
        async with pubsub.subscribe_run_updates("run1") as sub:
            assert sub is None


class TestPublishIsBestEffort:
    """A broken/unreachable Redis must never fail the caller (RunStore.mutate) —
    see the module docstring's rationale: viewers fall back to their own poll."""

    async def test_publish_swallows_broken_client(self, monkeypatch):
        class ExplodingClient:
            async def publish(self, channel, message):
                raise ConnectionError("redis unreachable")

        monkeypatch.setattr(pubsub, "_client", lambda: ExplodingClient())
        await pubsub.publish_run_update("run1")  # must not raise
