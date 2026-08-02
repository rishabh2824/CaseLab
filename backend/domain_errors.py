# Exceptions raised by services/ and infra/ to signal a business-rule
# violation. Deliberately has no FastAPI import — services stay testable with
# plain `pytest.raises(CaseNotFound)` instead of importing HTTPException and
# asserting on `.status_code`. main.py registers one exception handler
# (`domain_error_handler`) that maps every subclass here to an HTTP response
# by walking this hierarchy — see _lookup_exception_handler in Starlette,
# which resolves a registered handler through the exception's MRO, so
# registering the base `DomainError` class alone is enough to catch all of
# these.


class DomainError(Exception):
    status_code = 500
    headers: dict | None = None

    def __init__(self, detail):
        self.detail = detail
        super().__init__(detail if isinstance(detail, str) else str(detail))


class NotFoundError(DomainError):
    status_code = 404


class CaseNotFound(NotFoundError):
    pass


class RunNotFound(NotFoundError):
    pass


class AccessDenied(DomainError):
    status_code = 403


class InvalidRequest(DomainError):
    status_code = 400


class ConflictError(DomainError):
    status_code = 409


class VersionConflict(ConflictError):
    pass


class AccessCodeConflict(ConflictError):
    pass


class RateLimited(DomainError):
    status_code = 429

    def __init__(self, detail, retry_after: int):
        super().__init__(detail)
        self.headers = {"Retry-After": str(retry_after)}


class UpstreamError(DomainError):
    status_code = 502


class PersistenceError(DomainError):
    status_code = 500
