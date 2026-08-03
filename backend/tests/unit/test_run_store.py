"""services/simulation/run_store.py — the pure serialize/deserialize/expiry
helpers, with no database involved. `insertRun`/`getRun`/`updateRun` open a
real session and are out of scope here (they're exercised end-to-end via the
`sim` fixture elsewhere).
"""

from __future__ import annotations

import json

from services.simulation import run_store


# --------------------------------------------------------------------------
# serializeRun / deserializeRun round trip
# --------------------------------------------------------------------------


def test_serialize_run_sorts_unlocked_referred_ids_into_a_list():
    run = {"unlocked_referred_ids": {"C", "A", "B"}, "start_time": 1000.0}
    serialized = run_store.serializeRun(run)
    assert serialized["unlocked_referred_ids"] == ["A", "B", "C"]


def test_serialize_run_does_not_mutate_the_callers_run_dict():
    original_set = {"B", "A"}
    run = {"unlocked_referred_ids": original_set, "start_time": 1000.0}
    run_store.serializeRun(run)
    # The caller's dict must still hold the original set, untouched.
    assert run["unlocked_referred_ids"] is original_set
    assert isinstance(run["unlocked_referred_ids"], set)


def test_deserialize_run_turns_the_list_back_into_a_set():
    data = {"unlocked_referred_ids": ["A", "B"], "start_time": 1000.0}
    run = run_store.deserializeRun(data)
    assert run["unlocked_referred_ids"] == {"A", "B"}
    assert isinstance(run["unlocked_referred_ids"], set)


def test_deserialize_run_deep_copies_so_mutating_the_result_cannot_corrupt_the_stored_blob():
    data = {"persona_chat_state": {"A": {"warning_count": 0}}, "unlocked_referred_ids": ["B"]}
    run = run_store.deserializeRun(data)

    run["persona_chat_state"]["A"]["warning_count"] = 99
    run["persona_chat_state"]["Z"] = {"new": True}
    run["unlocked_referred_ids"].add("C")

    assert data["persona_chat_state"]["A"]["warning_count"] == 0
    assert "Z" not in data["persona_chat_state"]
    assert data["unlocked_referred_ids"] == ["B"]


def test_round_trip_through_json_survives_the_set_list_set_cycle():
    # This is what JSONB actually does under the hood — serialize, persist as
    # JSON text, and read it back — and it's exactly where a bare Python set
    # (not JSON-serializable at all) or an int dict key would misbehave.
    run = {
        "run_id": "r1",
        "case_id": 1,
        "start_time": 1000.0,
        "unlocked_referred_ids": {"B", "C"},
        "persona_chat_state": {"A": {"warning_count": 1, "ended": False, "end_reason": None, "last_flag_type": None}},
        "history": {"A": [{"role": "user", "content": "hi"}]},
    }
    blob = json.loads(json.dumps(run_store.serializeRun(run)))
    restored = run_store.deserializeRun(blob)

    assert restored["unlocked_referred_ids"] == {"B", "C"}
    assert isinstance(restored["unlocked_referred_ids"], set)
    assert restored["persona_chat_state"] == run["persona_chat_state"]
    assert restored["history"] == run["history"]


# --------------------------------------------------------------------------
# expiry
# --------------------------------------------------------------------------


def test_expiry_uses_duration_plus_grace_period():
    run = {"start_time": 1000.0, "case_snapshot": {"simulation_duration": 10}}
    expected = 1000.0 + (10 + run_store.GRACE_PERIOD) * 60
    assert run_store.expiry(run) == expected


def test_expiry_caps_at_run_lifetime_for_a_long_duration():
    run = {"start_time": 1000.0, "case_snapshot": {"simulation_duration": run_store.RUN_LIFETIME * 10}}
    expected = 1000.0 + run_store.RUN_LIFETIME * 60
    assert run_store.expiry(run) == expected


def test_expiry_falls_back_to_the_cap_when_case_has_no_duration():
    run = {"start_time": 1000.0, "case_snapshot": {"simulation_duration": None}}
    assert run_store.expiry(run) == 1000.0 + run_store.RUN_LIFETIME * 60


def test_expiry_falls_back_to_the_cap_when_case_snapshot_missing():
    run = {"start_time": 1000.0}
    assert run_store.expiry(run) == 1000.0 + run_store.RUN_LIFETIME * 60
