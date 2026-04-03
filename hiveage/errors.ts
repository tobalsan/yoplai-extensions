export interface HiveageErrorOptions {
  endpoint?: string;
  status?: number;
  correlationId?: string;
}

export class HiveageError extends Error {
  endpoint?: string;
  status?: number;
  correlationId?: string;

  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message);
    this.name = "HiveageError";
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.correlationId = options.correlationId;
  }
}

export class HiveageAuthError extends HiveageError {
  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message, options);
    this.name = "HiveageAuthError";
  }
}

export class HiveageRateLimitError extends HiveageError {
  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message, options);
    this.name = "HiveageRateLimitError";
  }
}

export class HiveageNotFoundError extends HiveageError {
  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message, options);
    this.name = "HiveageNotFoundError";
  }
}

export class HiveageValidationError extends HiveageError {
  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message, options);
    this.name = "HiveageValidationError";
  }
}

export class HiveageConnectionError extends HiveageError {
  constructor(message: string, options: HiveageErrorOptions = {}) {
    super(message, options);
    this.name = "HiveageConnectionError";
  }
}
