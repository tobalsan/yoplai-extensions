export interface ZendeskErrorOptions {
  endpoint?: string;
  status?: number;
  correlationId?: string;
}

export class ZendeskError extends Error {
  endpoint?: string;
  status?: number;
  correlationId?: string;

  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message);
    this.name = "ZendeskError";
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.correlationId = options.correlationId;
  }
}

export class ZendeskAuthError extends ZendeskError {
  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message, options);
    this.name = "ZendeskAuthError";
  }
}

export class ZendeskRateLimitError extends ZendeskError {
  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message, options);
    this.name = "ZendeskRateLimitError";
  }
}

export class ZendeskNotFoundError extends ZendeskError {
  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message, options);
    this.name = "ZendeskNotFoundError";
  }
}

export class ZendeskValidationError extends ZendeskError {
  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message, options);
    this.name = "ZendeskValidationError";
  }
}

export class ZendeskConnectionError extends ZendeskError {
  constructor(message: string, options: ZendeskErrorOptions = {}) {
    super(message, options);
    this.name = "ZendeskConnectionError";
  }
}
