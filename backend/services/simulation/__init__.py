"""Simulation engine, split by responsibility:

- ``state``      — the in-memory run store, TTL/cleanup, availability windows,
                    and per-persona chat (safety) state.
- ``reads``       — repository reads shaped into the dicts the rest of the
                    engine and the API responses expect.
- ``prompt``      — system-prompt construction, trigger resolution (referral/
                    file eligibility), and the persona reply envelope
                    (parsing/sanitizing the model's JSON output).
- ``repository``  — raw data access (SQL) for the simulations domain.
- ``service``     — orchestration: the operations the router calls
                    (``start_simulation``, ``prepare_message``,
                    ``stream_message``, ...), composed from the modules above.

External callers should import from ``services.simulation.service`` (the
router) or ``services.simulation.state`` (the app lifespan's cleanup task).
"""
