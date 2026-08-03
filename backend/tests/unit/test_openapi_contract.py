"""Regression test for backend/frontend OpenAPI schema drift.

frontend/src/lib/api/schema.d.ts is generated from this app's OpenAPI schema
by `pnpm gen:api` (frontend/package.json) and consumed throughout the
frontend (frontend/src/lib/api/client.ts). Nothing currently catches the case
where a backend pydantic model changes and nobody regenerates that file --
the frontend keeps compiling against a stale contract, silently, until
something breaks at runtime in the browser. This test compares
`app.openapi()["components"]["schemas"]` (the source of truth) against a
tolerant regex-based read of the checked-in .d.ts, so that class of drift
fails loudly here instead.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from main import app


# Located relative to *this file* (not cwd) so `uv run pytest` works the same
# from backend/ or anywhere else. This file is backend/tests/unit/test_openapi_contract.py,
# so parents[3] is the repo root (the parent of both backend/ and frontend/).
FRONTEND_SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "api" / "schema.d.ts"
)


# ---------------------------------------------------------------------------
# tolerant regex-based .d.ts reader
# ---------------------------------------------------------------------------
#
# openapi-typescript emits components.schemas roughly like this (tabs, not
# spaces -- confirmed against the checked-in file):
#
#   export interface components {
#   	schemas: {
#   		/** AddAdminRequest */
#   		AddAdminRequest: {
#   			/** Email */
#   			email: string;
#   			...
#   		};
#   		/**
#   		 * AdminRole
#   		 * @enum {integer}
#   		 */
#   		AdminRole: 1 | 2;
#   		...
#   	};
#   	responses: never;
#   	...
#   }
#
# This does not parse TypeScript -- it tracks brace *depth purely via leading
# tab count*, since openapi-typescript's generator puts exactly one
# property/entry per line:
#
#   depth 1 (`\tschemas: {`)         -- opens/closes the whole schemas block
#   depth 2 (`\t\tName: {` or `...;`) -- one line per schema name
#   depth 3 (`\t\t\tkey: ...;`)       -- one line per property of an object
#                                         schema directly under a depth-2 entry
#
# Anything deeper (nested inline object literals like RunStateResponse's
# `histories: { [key: string]: ... }`, or comment lines) is intentionally
# ignored. The goal is a parser that fails LOUDLY on real drift (a schema or
# field renamed/added/removed) and not on formatting -- exhaustively modeling
# openapi-typescript's output grammar is explicitly not the goal.

_SCHEMAS_OPEN = re.compile(r"^\tschemas:\s*\{\s*$")
_SCHEMAS_CLOSE = re.compile(r"^\t\};\s*$")
_ENTRY = re.compile(r"^\t\t([A-Za-z0-9_$]+):\s*(\{)?")
_ENTRY_CLOSE = re.compile(r"^\t\t\};\s*$")
_PROP = re.compile(r"^\t\t\t([A-Za-z0-9_$]+)\??:")


def parse_frontend_schemas(text: str) -> dict[str, set[str]]:
    """Returns {schema_name: {property_names}}` for every entry directly
    under components.schemas. A non-object schema (e.g. the `AdminRole: 1 | 2;`
    enum) gets an empty property set -- there's nothing to field-diff there
    beyond the name itself, which the name-set comparison already covers.
    """
    lines = text.splitlines()
    i, n = 0, len(lines)

    while i < n and not _SCHEMAS_OPEN.match(lines[i]):
        i += 1
    assert i < n, (
        "Could not find 'schemas: {' in schema.d.ts -- openapi-typescript's "
        "output format may have changed; update the parser in "
        "tests/unit/test_openapi_contract.py."
    )
    i += 1  # step past the `schemas: {` line itself

    schemas: dict[str, set[str]] = {}
    while i < n and not _SCHEMAS_CLOSE.match(lines[i]):
        match = _ENTRY.match(lines[i])
        if match is None:
            i += 1  # comment line, blank line, etc. -- not a schema entry
            continue

        name, is_object = match.group(1), match.group(2) == "{"
        i += 1
        props: set[str] = set()
        if is_object:
            while i < n and not _ENTRY_CLOSE.match(lines[i]):
                prop_match = _PROP.match(lines[i])
                if prop_match is not None:
                    props.add(prop_match.group(1))
                i += 1
            i += 1  # step past this entry's closing `};`
        schemas[name] = props

    return schemas


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def frontend_schemas() -> dict[str, set[str]]:
    if not FRONTEND_SCHEMA_PATH.exists():
        pytest.skip(
            f"frontend/src/lib/api/schema.d.ts not found at {FRONTEND_SCHEMA_PATH} "
            "-- skipping the OpenAPI/frontend contract check (no frontend checkout "
            "alongside backend/?)."
        )
    return parse_frontend_schemas(FRONTEND_SCHEMA_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def backend_schemas() -> dict[str, set[str]]:
    spec = app.openapi()
    return {
        name: set(body.get("properties", {}).keys())
        for name, body in spec["components"]["schemas"].items()
    }


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------


def test_frontend_schema_names_match_backend(backend_schemas, frontend_schemas):
    backend_names = set(backend_schemas)
    frontend_names = set(frontend_schemas)
    only_backend = sorted(backend_names - frontend_names)
    only_frontend = sorted(frontend_names - backend_names)
    assert not only_backend and not only_frontend, (
        "backend OpenAPI schema and frontend/src/lib/api/schema.d.ts have "
        "drifted on which schemas exist.\n"
        f"  in the backend but missing from schema.d.ts: {only_backend}\n"
        f"  in schema.d.ts but no longer in the backend: {only_frontend}\n"
        "Run `pnpm gen:api` in frontend/ to regenerate schema.d.ts from the live backend."
    )


def test_frontend_schema_fields_match_backend(backend_schemas, frontend_schemas):
    shared = sorted(set(backend_schemas) & set(frontend_schemas))
    mismatches: list[str] = []
    for name in shared:
        backend_props = backend_schemas[name]
        frontend_props = frontend_schemas[name]
        missing_in_frontend = sorted(backend_props - frontend_props)
        extra_in_frontend = sorted(frontend_props - backend_props)
        if missing_in_frontend or extra_in_frontend:
            mismatches.append(
                f"  {name}: backend has field(s) missing from schema.d.ts: "
                f"{missing_in_frontend or 'none'}; schema.d.ts has field(s) no "
                f"longer in the backend: {extra_in_frontend or 'none'}"
            )
    assert not mismatches, (
        "backend OpenAPI schema and frontend/src/lib/api/schema.d.ts have "
        "drifted on field names within a shared schema.\n"
        + "\n".join(mismatches)
        + "\nRun `pnpm gen:api` in frontend/ to regenerate schema.d.ts from the live backend."
    )
