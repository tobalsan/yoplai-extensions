export interface ExaErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
}

export class ExaError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;

  constructor(message: string, options: ExaErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class ExaAuthError extends ExaError {}

export class ExaNotFoundError extends ExaError {}

export class ExaRateLimitError extends ExaError {}

export class ExaServerError extends ExaError {}

export class ExaConnectionError extends ExaError {}

export class ExaValidationError extends ExaError {}
