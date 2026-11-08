export interface PipedriveErrorOptions {
  endpoint?: string;
  status?: number;
  responseBody?: string;
}

export class PipedriveError extends Error {
  endpoint?: string;
  status?: number;
  responseBody?: string;
  code?: string;

  constructor(message: string, options: PipedriveErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

export class PipedriveAuthError extends PipedriveError {}

export class PipedriveNotFoundError extends PipedriveError {}

export class PipedriveRateLimitError extends PipedriveError {}

export class PipedriveServerError extends PipedriveError {}

export class PipedriveConnectionError extends PipedriveError {}

/**
 * Caller mistake (bad local input or a Pipedrive 400/409/422). `code` and the
 * default 400 status make the gateway log it at warn and answer HTTP 400.
 */
export class PipedriveValidationError extends PipedriveError {
  constructor(message: string, options: PipedriveErrorOptions = {}) {
    super(message, { ...options, status: options.status ?? 400 });
    this.code = "invalid_input";
  }
}

/**
 * A mutation may or may not have been applied (timeout, network failure, 5xx,
 * malformed success body). Never replay automatically; reconcile by reading.
 */
export class PipedriveOutcomeUnknownError extends PipedriveError {}
