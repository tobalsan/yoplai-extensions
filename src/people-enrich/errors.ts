export interface PeopleEnrichErrorOptions {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;
}

export class PeopleEnrichError extends Error {
  endpoint?: string;
  status?: number;
  requestId?: string;
  responseBody?: string;

  constructor(message: string, options: PeopleEnrichErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class PeopleEnrichAuthError extends PeopleEnrichError {}

export class PeopleEnrichTermsRequiredError extends PeopleEnrichError {}

export class PeopleEnrichRateLimitError extends PeopleEnrichError {}

export class PeopleEnrichServerError extends PeopleEnrichError {}

export class PeopleEnrichConnectionError extends PeopleEnrichError {}

export class PeopleEnrichValidationError extends PeopleEnrichError {}

/** Upstream data provider failed (e.g. provider_error 502). Not billed. */
export class PeopleEnrichProviderError extends PeopleEnrichError {}
