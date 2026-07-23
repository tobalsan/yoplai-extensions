export interface FirecrawlErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
}

export class FirecrawlError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;

  constructor(message: string, options: FirecrawlErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class FirecrawlAuthError extends FirecrawlError {}

export class FirecrawlNotFoundError extends FirecrawlError {}

export class FirecrawlRateLimitError extends FirecrawlError {}

export class FirecrawlServerError extends FirecrawlError {}

export class FirecrawlConnectionError extends FirecrawlError {}

export class FirecrawlValidationError extends FirecrawlError {}
