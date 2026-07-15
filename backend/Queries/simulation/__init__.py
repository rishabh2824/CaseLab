"""SQL for the simulations domain, split by table:

- ``repository`` — reads for cases/personas/files/referrals (the same tables
                    the cases admin domain writes).
- ``runs``        — the ``simulation_runs`` table: the DB-backed run store
                    (``RunStore``), TTL/cleanup, and the domain exceptions it
                    raises.

See ``services.simulation`` for the orchestration built on top of these.
"""
