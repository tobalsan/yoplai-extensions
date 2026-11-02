import {
  CompanyParamsSchema, CompanyResponseSchema, CompanySchema, PersonParamsSchema,
  PersonResponseSchema, PersonSchema, UsageResultSchema,
  type CompanyParams, type LushaConfig, type PersonParams,
} from "./models.js";
import {
  LushaAuthError, LushaConnectionError, LushaError, LushaOutOfCreditsError,
  LushaRateLimitError, LushaServerError, LushaValidationError,
} from "./errors.js";

export class LushaClient {
  constructor(private readonly config: LushaConfig) {}

  async findPerson(input: PersonParams, reveal: "emails" | "phones") {
    const parsed = PersonParamsSchema.safeParse(input);
    if (!parsed.success) throw new LushaValidationError("Invalid person identifiers: " + parsed.error.message);
    const contact = parsed.data;
    if (!contact.linkedinUrl && !(contact.firstName && contact.lastName && (contact.companyDomain || contact.companyName))) {
      throw new LushaValidationError("Provide linkedinUrl or firstName, lastName and companyDomain or companyName");
    }
    const data = PersonResponseSchema.parse(await this.request("/v3/contacts/search-and-enrich", {
      contacts: [contact], reveal: [reveal],
    }));
    const result = data.results[0];
    const emails = result?.emails ?? [];
    const phones = result?.phones ?? [];
    return {
      found: !result?.error && (reveal === "emails" ? emails.some((email) => email.email.length > 0) : phones.some((phone) => phone.number.length > 0)),
      creditsUsed: data.billing.creditsCharged,
      billingStatus: data.billing.status,
      lowBalance: data.billing.lowBalance,
      errorCode: result?.error?.code,
      missingDataPoints: result?.missingDataPoints,
      reason: result?.error?.code === "COMPLIANCE_RESTRICTED" ? "Legal restriction" : undefined,
      ...(reveal === "emails" ? { emails } : { phones }),
      person: result ? PersonSchema.parse(result) : undefined,
    };
  }

  async findCompany(input: CompanyParams) {
    const parsed = CompanyParamsSchema.safeParse(input);
    if (!parsed.success || !(parsed.data.domain || parsed.data.name)) {
      throw new LushaValidationError("Provide a company domain or name");
    }
    const data = CompanyResponseSchema.parse(await this.request("/v3/companies/search-and-enrich", { companies: [parsed.data] }));
    const result = data.results[0];
    return {
      found: !!result && !result.error && !!(result.id || result.name || result.domain),
      creditsUsed: data.billing.creditsCharged,
      billingStatus: data.billing.status,
      lowBalance: data.billing.lowBalance,
      errorCode: result?.error?.code,
      missingDataPoints: result?.missingDataPoints,
      reason: result?.error?.code === "COMPLIANCE_RESTRICTED" ? "Legal restriction" : undefined,
      company: result && !result.error ? CompanySchema.parse(result) : undefined,
    };
  }

  async accountUsage() {
    return UsageResultSchema.parse(await this.request("/v3/account/usage"));
  }

  async validate() {
    await this.accountUsage();
    return { ok: true };
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`https://api.lusha.com${path}`, {
          method: body ? "POST" : "GET",
          headers: { api_key: this.config.apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
        });
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          const seconds = header === null ? NaN : Number(header);
          const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : header && Number.isFinite(Date.parse(header)) ? Math.max(0, Date.parse(header) - Date.now()) : 1000;
          // Defer long waits to the caller rather than retrying before the server allows it.
          if (attempt >= 2 || delay > (this.config.timeoutMs ?? 30_000)) {
            throw new LushaRateLimitError("Lusha rate limit exceeded; stop and retry later", { endpoint: path, status: 429 });
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (response.status === 451 && body) {
          return { results: [{ error: { code: "COMPLIANCE_RESTRICTED" } }], billing: { creditsCharged: 0 } };
        }
        if (!response.ok) {
          const options = { endpoint: path, status: response.status };
          if (response.status === 401 || response.status === 403) {
            throw new LushaAuthError("Lusha key invalid, account inactive, or plan access denied", options);
          }
          if (response.status === 402) throw new LushaOutOfCreditsError("Lusha credit balance exhausted", options);
          if ([400, 412, 422].includes(response.status)) throw new LushaValidationError("Lusha rejected the request identifiers", options);
          if (response.status === 499 || response.status >= 500) throw new LushaServerError("Lusha server failure; request was not retried", options);
          throw new LushaError(`Lusha request failed with HTTP ${response.status}`, options);
        }
        return await response.json();
      } catch (error) {
        if (error instanceof LushaError) throw error;
        if (error instanceof Error && (error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new LushaConnectionError("Lusha connection failed or timed out; request was not retried", { endpoint: path });
        }
        throw error;
      }
    }
  }
}
