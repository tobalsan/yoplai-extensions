export interface PipedriveErrorOptions {
  endpoint?: string;
  status?: number;
  responseBody?: string;
}

export class PipedriveError extends Error {
  endpoint?: string;
  status?: number;
  responseBody?: string;

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

export class PipedriveValidationError extends PipedriveError {}
