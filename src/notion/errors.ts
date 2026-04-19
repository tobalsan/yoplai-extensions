export interface NotionErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
}

export class NotionError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;

  constructor(message: string, options: NotionErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export class NotionAuthError extends NotionError {}

export class NotionNotFoundError extends NotionError {}

export class NotionRateLimitError extends NotionError {}

export class NotionServerError extends NotionError {}

export class NotionConnectionError extends NotionError {}

export class NotionValidationError extends NotionError {}
