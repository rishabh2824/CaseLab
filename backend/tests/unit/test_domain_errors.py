"""domain_errors.py — every DomainError subclass maps to the HTTP status code
main.py's single exception handler relies on when it walks the MRO (see the
module docstring there). No FastAPI import needed, per that same design."""

from __future__ import annotations

import pytest

import domain_errors as errors


@pytest.mark.parametrize(
    "exc_class,expected_status",
    [
        (errors.DomainError, 500),
        (errors.NotFoundError, 404),
        (errors.CaseNotFound, 404),
        (errors.RunNotFound, 404),
        (errors.AccessDenied, 403),
        (errors.InvalidRequest, 400),
        (errors.ConflictError, 409),
        (errors.VersionConflict, 409),
        (errors.AccessCodeConflict, 409),
        (errors.RateLimited, 429),
        (errors.UpstreamError, 502),
        (errors.PersistenceError, 500),
    ],
)
def test_status_code_matches_intended_http_status(exc_class, expected_status):
    assert exc_class.status_code == expected_status


def test_rate_limited_sets_retry_after_header():
    exc = errors.RateLimited("Too many requests.", retry_after=30)
    assert exc.headers == {"Retry-After": "30"}
    assert exc.detail == "Too many requests."


def test_domain_error_str_uses_detail_when_it_is_a_string():
    exc = errors.CaseNotFound("No case found.")
    assert str(exc) == "No case found."


def test_dict_detail_survives_construction_and_str_does_not_crash():
    # The version-conflict shape from services/cases.py: a dict detail, not a
    # plain string.
    detail = {"message": "changed by someone else", "code": "version_conflict"}
    exc = errors.VersionConflict(detail)
    assert exc.detail == detail
    assert str(exc)  # must not raise
