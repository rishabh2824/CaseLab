# Exceptions raised by services/ and infra/ to signal a business-rule violation.


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


class Unauthorized(DomainError):
    status_code = 401


class AccessDenied(DomainError):
    status_code = 403


class SuperAdminProtected(AccessDenied):
    pass


class InvalidRequest(DomainError):
    status_code = 400


class ConflictError(DomainError):
    status_code = 409


class VersionConflict(ConflictError):
    pass


class AccessCodeConflict(ConflictError):
    pass


class AdminEmailTaken(ConflictError):
    pass


class AdminNotFound(NotFoundError):
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
