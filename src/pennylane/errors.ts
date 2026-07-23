export interface PennylaneErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
}

export class PennylaneError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;

  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message);
    this.name = "PennylaneError";
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class PennylaneAuthError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneAuthError";
  }
}

export class PennylaneRateLimitError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneRateLimitError";
  }
}

export class PennylaneNotFoundError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneNotFoundError";
  }
}

export class PennylaneValidationError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneValidationError";
  }
}

export class PennylaneConnectionError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneConnectionError";
  }
}

/**
 * Raised when DraftGuard refuses a mutation because the target is not editable
 * (a finalized invoice, or a non-`pending` quote). Signals a safe refusal — the
 * write never reached Pennylane.
 */
export class PennylaneGuardRefusedError extends PennylaneError {
  constructor(message: string, options: PennylaneErrorOptions = {}) {
    super(message, options);
    this.name = "PennylaneGuardRefusedError";
  }
}
