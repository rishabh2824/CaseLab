"""Pure data access. Every function under this package runs SQL (via
infra.db's client) and returns dicts/rows shaped by column name — no
HTTPException, no business rules, no orchestration. Callers are services/*.
"""
