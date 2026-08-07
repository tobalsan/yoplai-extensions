export interface NotionErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
}

export class NotionError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;

  constructor(message: string, options: NotionErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class NotionAuthError extends NotionError {}

export class NotionNotFoundError extends NotionError {}

export class NotionRateLimitError extends NotionError {}

export class NotionServerError extends NotionError {}

export class NotionConnectionError extends NotionError {}

export class NotionValidationError extends NotionError {}

export class NotionFileExtractionError extends NotionError {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: NotionErrorOptions & { code: string; retryable?: boolean }) {
    super(message, options);
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status ?? null,
      endpoint: this.endpoint ?? null,
    };
  }
}
