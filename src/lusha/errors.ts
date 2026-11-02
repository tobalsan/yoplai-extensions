export interface LushaErrorOptions {
  endpoint?: string;
  status?: number;
}

export class LushaError extends Error {
  endpoint?: string;
  status?: number;

  constructor(message: string, options: LushaErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
  }
}

export class LushaValidationError extends LushaError {}
export class LushaAuthError extends LushaError {}
export class LushaOutOfCreditsError extends LushaError {}
export class LushaServerError extends LushaError {}
export class LushaRateLimitError extends LushaError {}
export class LushaConnectionError extends LushaError {}
