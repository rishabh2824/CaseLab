"""Simulation engine, split by responsibility:

- ``turn_state`` — pure, no-I/O helpers over an in-memory run dict:
                    availability windows and per-persona chat (safety) state.
- ``reads``       — repository reads shaped into the dicts the rest of the
                    engine and the API responses expect.
- ``prompt``      — system-prompt construction, trigger resolution (referral/
                    file eligibility), and the persona reply envelope
                    (parsing/sanitizing the model's JSON output).
- ``service``     — orchestration: the operations the router calls
                    (``start_simulation``, ``prepare_message``,
                    ``stream_message``, ...), composed from the modules above.

Raw SQL for this domain lives one layer down, in
``Queries.simulation`` — ``repository`` (case/persona reads) and
``runs`` (the DB-backed run store, ``RunStore``).

External callers should import from ``services.simulation.service`` (the
router) or ``Queries.simulation.runs`` (the app lifespan's cleanup task).
"""
