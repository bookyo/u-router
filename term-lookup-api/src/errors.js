class ApiError extends Error {
  constructor(status, error, message = error) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

class ParentNotFoundError extends ApiError {
  constructor() { super(400, 'parent_not_found'); }
}
class ParentCycleError extends ApiError {
  constructor() { super(400, 'parent_cycle'); }
}
class LegacyConflictError extends ApiError {
  constructor(error = 'term_conflict') {
    super(409, error);
    // Retain the repository's v1 error contract for existing integrations.
    this.code = 'ERR_SQLITE_ERROR';
    this.errcode = 2067;
  }
}

module.exports = { ApiError, ParentNotFoundError, ParentCycleError, LegacyConflictError };
