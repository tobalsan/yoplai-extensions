export interface ConfluenceErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
}

export class ConfluenceError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;

  constructor(message: string, options: ConfluenceErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export class ConfluenceAuthError extends ConfluenceError {}

export class ConfluenceNotFoundError extends ConfluenceError {}

export class ConfluenceRateLimitError extends ConfluenceError {}

export class ConfluenceServerError extends ConfluenceError {}

export class ConfluenceConnectionError extends ConfluenceError {}

export class ConfluenceValidationError extends ConfluenceError {}
