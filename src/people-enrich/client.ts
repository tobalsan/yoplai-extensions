import {
  PeopleEnrichAuthError,
  PeopleEnrichConnectionError,
  PeopleEnrichError,
  PeopleEnrichProviderError,
  PeopleEnrichRateLimitError,
  PeopleEnrichServerError,
  PeopleEnrichTermsRequiredError,
  PeopleEnrichValidationError,
} from "./errors.js";
import type {
  FindMobileParams,
  FindWorkEmailParams,
  LookupCompanyParams,
  LookupPersonParams,
  PeopleEnrichConfig,
  ReverseEmailParams,
  SearchPeopleParams,
} from "./models.js";

type Json = Record<string, unknown>;

/** Result of one catalog capability call. */
export interface CapabilityResult {
  found: boolean;
  creditsUsed: number;
  data: Json;
}

const MAX_RATE_LIMIT_RETRIES = 5;
/** Extra tries for a step whose provider timed out without charging credits. */
const MAX_TIMEOUT_RETRIES = 2;
const PROVIDER_TIMEOUT_CODES = new Set(["deadline_exceeded", "timeout", "request_timeout", "gateway_timeout"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compact(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== null && nested !== ""),
  );
}

function rec(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinParts(...parts: unknown[]): string | undefined {
  const joined = parts.map(str).filter(Boolean).join(", ");
  return joined || undefined;
}

function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** Normalizes a profile returned by the primary (FullEnrich-shaped) provider. */
export function normalizeProfile(raw: unknown): Json | undefined {
  const person = rec(raw);
  if (Object.keys(person).length === 0) return undefined;
  const employment = rec(person.employment);
  const current = rec(employment.current);
  const currentCompany = rec(current.company);
  const location = rec(person.location);
  const socials = rec(person.social_profiles);
  return compact({
    name: str(person.full_name) ?? ([str(person.first_name), str(person.last_name)].filter(Boolean).join(" ") || undefined),
    headline: str(person.headline),
    about: str(person.description)?.slice(0, 600),
    location: joinParts(location.city, location.region, location.country),
    currentTitle: str(current.title),
    currentCompany: str(currentCompany.name),
    currentCompanyDomain: str(currentCompany.domain) ?? domainOf(str(currentCompany.website)),
    linkedinUrl: str(rec(socials.professional_network).url) ?? str(person.professional_network_url),
    experience: arr(employment.all).map((job) => {
      const company = rec(job.company);
      return compact({
        title: str(job.title),
        company: str(company.name),
        domain: str(company.domain),
        start: str(job.start_at)?.slice(0, 7),
        end: job.is_current ? "present" : str(job.end_at)?.slice(0, 7),
      });
    }),
  });
}

/** Normalizes an Apollo person record. */
export function normalizeApolloPerson(raw: unknown): Json | undefined {
  const person = rec(raw);
  if (Object.keys(person).length === 0) return undefined;
  const org = rec(person.organization);
  return compact({
    apolloId: str(person.id),
    name: str(person.name),
    headline: str(person.headline),
    location: joinParts(person.city, person.state, person.country),
    currentTitle: str(person.title),
    currentCompany: str(org.name),
    currentCompanyDomain: str(org.primary_domain),
    linkedinUrl: str(person.linkedin_url),
    email: str(person.email),
    emailStatus: str(person.email_status),
    experience: arr(person.employment_history).map((job) =>
      compact({
        title: str(job.title),
        company: str(job.organization_name),
        start: str(job.start_date)?.slice(0, 7),
        end: job.current ? "present" : str(job.end_date)?.slice(0, 7),
      }),
    ),
  });
}

export function normalizeCompany(raw: unknown): Json | undefined {
  const company = rec(raw);
  if (Object.keys(company).length === 0) return undefined;
  const hq = rec(rec(company.locations).headquarters);
  return compact({
    name: str(company.name),
    domain: str(company.domain) ?? domainOf(str(company.website)),
    website: str(company.website),
    description: str(company.description)?.slice(0, 800),
    industry: str(rec(company.industry).main_industry) ?? str(company.industry),
    yearFounded: company.year_founded,
    headcount: company.headcount,
    headcountRange: str(company.headcount_range),
    companyType: str(company.company_type),
    headquarters: joinParts(hq.line1, hq.line2) ?? joinParts(hq.city, hq.country),
    specialties: Array.isArray(company.specialties) ? company.specialties : undefined,
    linkedinUrl: str(rec(rec(company.social_profiles).professional_network).url),
  });
}

/** Normalizes an Apollo organization record. */
export function normalizeApolloCompany(raw: unknown): Json | undefined {
  const org = rec(raw);
  if (Object.keys(org).length === 0) return undefined;
  return compact({
    name: str(org.name),
    domain: str(org.primary_domain) ?? domainOf(str(org.website_url)),
    website: str(org.website_url),
    description: str(org.short_description)?.slice(0, 800),
    industry: str(org.industry),
    yearFounded: org.founded_year,
    headcount: org.estimated_num_employees,
    annualRevenue: org.annual_revenue,
    headquarters: joinParts(org.city, org.state, org.country),
    linkedinUrl: str(org.linkedin_url),
    technologies: Array.isArray(org.technology_names) ? org.technology_names.slice(0, 20) : undefined,
  });
}

function firstResult(data: Json): Json {
  return rec(arr(data.results)[0]);
}

/** Data Legion text fields come as a string or `{cleaned, display, raw}`. */
function cleaned(value: unknown): string | undefined {
  return str(value) ?? str(rec(value).display) ?? str(rec(value).cleaned);
}

function legionMatch(data: Json): Json {
  return rec(rec(arr(data.matches)[0]).person);
}

/** Normalizes a Data Legion person record. */
export function normalizeLegionPerson(raw: unknown): Json | undefined {
  const person = rec(raw);
  if (Object.keys(person).length === 0) return undefined;
  return compact({
    name: str(person.full_name) ?? ([str(person.first_name), str(person.last_name)].filter(Boolean).join(" ") || undefined),
    headline: cleaned(person.headline),
    location: joinParts(person.city, person.state, person.country),
    currentTitle: cleaned(person.job_title),
    currentCompany: cleaned(person.company_name),
    currentCompanyDomain: str(person.company_domain),
    linkedinUrl: str(person.linkedin_url),
    experience: arr(person.experience).map((job) => {
      const org = rec(job.organization);
      return compact({
        title: cleaned(job.title),
        company: cleaned(org.name),
        domain: str(org.website),
        start: str(job.start_date)?.slice(0, 7),
        end: job.current ? "present" : str(job.end_date)?.slice(0, 7),
      });
    }),
  });
}

/** Normalizes a Data Legion company record. */
export function normalizeLegionCompany(raw: unknown): Json | undefined {
  const company = rec(raw);
  if (Object.keys(company).length === 0) return undefined;
  return compact({
    name: cleaned(company.name),
    domain: str(company.domain),
    description: cleaned(company.headline),
    industry: cleaned(company.industry),
    yearFounded: company.founded,
    headcount: company.legion_employee_count ?? company.linkedin_employee_count,
    headcountRange: str(company.size),
    companyType: str(company.type),
    linkedinUrl: str(company.linkedin_url),
    headcountGrowth12m: rec(company.legion_employee_growth_rate)["12m"],
  });
}

interface PersonIdentifiers {
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
  companyDomain?: string;
  companyName?: string;
}

interface CascadeStep {
  provider: string;
  capability: string;
  options: Json;
  /** Returns the useful payload, or undefined when the hit lacks it. */
  extract(data: Json): Json | undefined;
}

export class PeopleEnrichClient {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly baseUrl = "https://api.firecrawl.dev/v2";
  /** Pause between free provider-timeout retries; injectable for tests. */
  readonly retryDelayMs: number;

  constructor(options: PeopleEnrichConfig & { retryDelayMs?: number }) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /** Free candidate search. Last names come back masked; use ids with find_work_email. */
  async searchPeople(params: SearchPeopleParams): Promise<Json> {
    if (!params.name && !params.companyDomains && !params.titles) {
      throw new PeopleEnrichValidationError("Provide at least one of name, companyDomains, or titles");
    }
    const result = await this.callCapability(
      "apollo",
      "people/search",
      compact({
        q_keywords: params.name,
        q_organization_domains_list: params.companyDomains,
        person_titles: params.titles,
        person_locations: params.locations,
        page: params.page,
        per_page: params.perPage ?? 25,
      }),
    );
    const people = arr(result.data.people).map((person) => {
      const org = rec(person.organization);
      const phone = person.has_direct_phone;
      return compact({
        apolloId: str(person.id),
        firstName: str(person.first_name),
        lastNameMasked: str(person.last_name_obfuscated),
        title: str(person.title),
        company: str(org.name),
        hasEmail: person.has_email,
        hasDirectPhone: typeof phone === "string" && phone.startsWith("Maybe") ? "maybe" : phone,
      });
    });
    return {
      provider: "apollo",
      creditsUsed: result.creditsUsed,
      totalMatches: result.data.total_entries ?? people.length,
      people,
    };
  }

  /** Profile, no contact data: primary (5) → Data Legion (10) → Apollo (30); each billed only on a match. */
  async lookupPerson(params: LookupPersonParams): Promise<Json> {
    if (!params.linkedinUrl && !(params.name && (params.companyDomain || params.companyName))) {
      throw new PeopleEnrichValidationError("Provide linkedinUrl, or name together with companyDomain or companyName");
    }
    const steps: CascadeStep[] = [];
    if (params.linkedinUrl || params.companyDomain) {
      steps.push({
        provider: "fullenrich",
        capability: "people/lookup",
        options: compact({
          person_professional_network_url: params.linkedinUrl,
          person_name: params.name,
          company_domain: domainOf(params.companyDomain),
        }),
        extract: (data) => {
          const person = normalizeProfile(arr(data.people)[0]);
          return person ? { person } : undefined;
        },
      });
    }
    steps.push({
      provider: "datalegion",
      capability: "people/enrich-base-no-contact",
      options: compact({
        social_url: params.linkedinUrl,
        full_name: params.name,
        company: domainOf(params.companyDomain) ?? params.companyName,
        min_confidence: "moderate",
        titlecase: true,
      }),
      extract: (data) => {
        const person = normalizeLegionPerson(legionMatch(data));
        return person ? { person } : undefined;
      },
    });
    steps.push(
      this.apolloProfileStep({
        linkedin_url: params.linkedinUrl,
        name: params.name,
        domain: domainOf(params.companyDomain),
        organization_name: params.companyName,
      }),
    );
    return await this.cascade(steps, { person: null });
  }

  /**
   * Work email: primary (20 on find) → Apollo by id (30 per matched person, even
   * without an email) → Data Legion with-contact (50, billed only when a work
   * email exists) → Apollo by identifiers when no id was given.
   */
  async findWorkEmail(params: FindWorkEmailParams): Promise<Json> {
    const identified = this.hasPersonIdentifiers(params);
    if (!identified && !params.apolloId) {
      throw new PeopleEnrichValidationError(
        "Provide linkedinUrl, or firstName + lastName + companyDomain/companyName, or apolloId",
      );
    }
    const steps: CascadeStep[] = [];
    if (identified) {
      steps.push({
        provider: "fullenrich",
        capability: "contacts/work-email",
        options: this.contactInput(params),
        extract: (data) => {
          const first = firstResult(data);
          const contact = rec(first.contact_info);
          const best = rec(contact.most_probable_work_email);
          if (!str(best.email)) return undefined;
          return {
            email: best.email,
            emailStatus: str(best.status) ?? null,
            otherEmails: arr(contact.work_emails)
              .map((item) => str(item.email))
              .filter((email) => email && email !== best.email),
            person: normalizeProfile(first.profile) ?? null,
          };
        },
      });
    }
    if (params.apolloId) {
      steps.push(this.apolloEmailStep({ id: params.apolloId }));
    }
    if (identified) {
      steps.push({
        provider: "datalegion",
        capability: "people/enrich-base-with-contact",
        options: {
          ...this.legionInput(params),
          required_fields: "work_email",
          exclude_fields: "phones,mobile_phone",
        },
        extract: (data) => {
          const match = legionMatch(data);
          const email = str(match.work_email);
          if (!email) return undefined;
          const others = arr(match.emails)
            .filter((item) => item.type === "professional" && item.address !== email)
            .map((item) => str(item.address));
          return {
            email,
            emailStatus: arr(match.emails).find((item) => item.address === email)?.validated ? "validated" : null,
            otherEmails: others,
            person: normalizeLegionPerson(match) ?? null,
          };
        },
      });
      if (!params.apolloId) {
        steps.push(
          this.apolloEmailStep({
            linkedin_url: params.linkedinUrl,
            first_name: params.firstName,
            last_name: params.lastName,
            domain: domainOf(params.companyDomain),
            organization_name: params.companyName,
          }),
        );
      }
    }
    return await this.cascade(steps, { email: null });
  }

  /** Mobile: Data Legion (50, billed only when a mobile exists) → primary (175 on find). */
  async findMobile(params: FindMobileParams): Promise<Json> {
    if (!this.hasPersonIdentifiers(params)) {
      throw new PeopleEnrichValidationError("Provide linkedinUrl, or firstName + lastName + companyDomain/companyName");
    }
    return await this.cascade(
      [
        {
          provider: "datalegion",
          capability: "people/enrich-base-with-contact",
          options: {
            ...this.legionInput(params),
            required_fields: "phones.type:mobile",
            exclude_fields: "emails,work_email",
          },
          extract: (data) => {
            const match = legionMatch(data);
            const phones = arr(match.phones)
              .filter((phone) => phone.type === "mobile")
              .map((phone) => compact({ number: str(phone.number), lineType: "MOBILE", confidence: str(phone.confidence) }));
            const phone = str(match.mobile_phone) ?? str(phones[0]?.number);
            return phone ? { phone, phones } : undefined;
          },
        },
        {
          provider: "fullenrich",
          capability: "contacts/mobile",
          options: this.contactInput(params),
          extract: (data) => {
            const contact = rec(firstResult(data).contact_info);
            const best = str(rec(contact.most_probable_phone).number);
            if (!best) return undefined;
            return {
              phone: best,
              phones: arr(contact.phones).map((phone) =>
                compact({
                  number: str(phone.number),
                  region: str(phone.region),
                  lineType: str(phone.line_type),
                  status: str(phone.line_status),
                }),
              ),
            };
          },
        },
      ],
      { phone: null },
    );
  }

  /** Who is behind an email: Data Legion (10) → primary (20) → Apollo (30); each billed only on a match. */
  async reverseEmail(params: ReverseEmailParams): Promise<Json> {
    return await this.cascade(
      [
        {
          provider: "datalegion",
          capability: "people/enrich-base-no-contact",
          options: { email: params.email, min_confidence: "moderate", titlecase: true },
          extract: (data) => {
            const person = normalizeLegionPerson(legionMatch(data));
            return person ? { person } : undefined;
          },
        },
        {
          provider: "fullenrich",
          capability: "contacts/reverse-email",
          options: { email: params.email },
          extract: (data) => {
            const person = normalizeProfile(firstResult(data).profile ?? arr(data.people)[0]);
            return person ? { person } : undefined;
          },
        },
        this.apolloProfileStep({ email: params.email }),
      ],
      { person: null },
    );
  }

  /** Firmographics: primary (5) → Data Legion (10) → Apollo (30); each billed only on a match. */
  async lookupCompany(params: LookupCompanyParams): Promise<Json> {
    if (!params.domain && !params.linkedinUrl) {
      throw new PeopleEnrichValidationError("Provide domain or linkedinUrl");
    }
    return await this.cascade(
      [
        {
          provider: "fullenrich",
          capability: "companies/lookup",
          options: compact({ domain: domainOf(params.domain), professional_network_url: params.linkedinUrl }),
          extract: (data) => {
            const company = normalizeCompany(arr(data.companies)[0] ?? data.company ?? arr(data.results)[0]);
            return company ? { company } : undefined;
          },
        },
        {
          provider: "datalegion",
          capability: "companies/enrich-base",
          options: compact({ domain: domainOf(params.domain), social_url: params.linkedinUrl, titlecase: true }),
          extract: (data) => {
            const company = normalizeLegionCompany(rec(arr(data.matches)[0]).company);
            return company ? { company } : undefined;
          },
        },
        {
          provider: "apollo",
          capability: "companies/bulk-enrich",
          options: { details: [compact({ domain: domainOf(params.domain), linkedin_url: params.linkedinUrl })] },
          extract: (data) => {
            const company = normalizeApolloCompany(arr(data.organizations)[0]);
            return company ? { company } : undefined;
          },
        },
      ],
      { company: null },
    );
  }

  /** Free: checks the API key against the catalog search endpoint. */
  async validate(): Promise<Json> {
    await this.requestJson("/search", { query: "find a person's work email", sources: ["alexandria"] });
    return { ok: true };
  }

  /** Free: remaining credits and current billing period for this API key. */
  async creditUsage(): Promise<Json> {
    const response = await this.requestJson("/team/credit-usage");
    const data = rec(response.data ?? response);
    const num = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      remainingCredits: num(data.remainingCredits),
      planCredits: num(data.planCredits),
      billingPeriodStart: str(data.billingPeriodStart) ?? null,
      billingPeriodEnd: str(data.billingPeriodEnd) ?? null,
    };
  }

  /**
   * Runs steps cheapest-first and stops at the first hit. Misses and unbilled
   * provider failures fall through to the next source; auth and connection
   * failures abort. A step whose provider reports a timeout (deadline_exceeded)
   * while charging 0 credits is retried up to MAX_TIMEOUT_RETRIES more times
   * (~1 s apart) before falling through; our own HTTP timeouts, billed errors
   * and other provider errors are never retried.
   */
  private async cascade(steps: CascadeStep[], empty: Json): Promise<Json> {
    const attempts: Json[] = [];
    let creditsUsed = 0;
    for (const step of steps) {
      for (let retries = 0; ; retries += 1) {
        const retryInfo = retries > 0 ? { retries } : {};
        try {
          const result = await this.callCapability(step.provider, step.capability, step.options);
          creditsUsed += result.creditsUsed;
          const value = result.found ? step.extract(result.data) : undefined;
          attempts.push({ provider: step.provider, creditsUsed: result.creditsUsed, found: Boolean(value), ...retryInfo });
          if (value) {
            return { found: true, provider: step.provider, ...value, creditsUsed, attempts };
          }
        } catch (error) {
          if (error instanceof PeopleEnrichAuthError || error instanceof PeopleEnrichConnectionError) {
            throw error;
          }
          if (!(error instanceof PeopleEnrichError)) throw error;
          const charged = error instanceof PeopleEnrichProviderError ? error.creditsUsed : 0;
          const freeTimeout =
            error instanceof PeopleEnrichProviderError && charged === 0 && PROVIDER_TIMEOUT_CODES.has(error.code ?? "");
          if (freeTimeout && retries < MAX_TIMEOUT_RETRIES) {
            await sleep(this.retryDelayMs);
            continue;
          }
          creditsUsed += charged;
          attempts.push({ provider: step.provider, creditsUsed: charged, found: false, error: error.message, ...retryInfo });
        }
        break;
      }
    }
    return { found: false, ...empty, creditsUsed, attempts };
  }

  /** Apollo bulk-match: 30 per matched person, unmatched records are free. */
  private apolloMatchStep(details: Json, extract: (person: Json) => Json | undefined): CascadeStep {
    return {
      provider: "apollo",
      capability: "people/bulk-match",
      options: { details: [compact(details)] },
      extract: (data) => {
        const person = normalizeApolloPerson(arr(data.matches)[0]);
        return person ? extract(person) : undefined;
      },
    };
  }

  private apolloProfileStep(details: Json): CascadeStep {
    return this.apolloMatchStep(details, ({ email: _email, emailStatus: _status, ...person }) => {
      void _email;
      void _status;
      return { person };
    });
  }

  private apolloEmailStep(details: Json): CascadeStep {
    return this.apolloMatchStep(details, ({ email, emailStatus, ...person }) => {
      // Apollo returns a placeholder like email_not_unlocked@domain.com when locked.
      if (typeof email !== "string" || email.startsWith("email_not_unlocked")) return undefined;
      return { email, emailStatus: emailStatus ?? null, person };
    });
  }

  private hasPersonIdentifiers(params: PersonIdentifiers): boolean {
    return Boolean(
      params.linkedinUrl || (params.firstName && params.lastName && (params.companyDomain || params.companyName)),
    );
  }

  private legionInput(params: PersonIdentifiers): Json {
    return compact({
      social_url: params.linkedinUrl,
      first_name: params.firstName,
      last_name: params.lastName,
      company: domainOf(params.companyDomain) ?? params.companyName,
      min_confidence: "high",
      titlecase: true,
    });
  }

  private contactInput(params: PersonIdentifiers): Json {
    return compact({
      linkedin_url: params.linkedinUrl,
      first_name: params.firstName,
      last_name: params.lastName,
      domain: domainOf(params.companyDomain),
      company_name: params.companyName,
    });
  }

  async callCapability(provider: string, capability: string, options: Json): Promise<CapabilityResult> {
    const response = await this.requestJson("/scrape", { alexandria: { provider, capability, options } });
    const body = rec(response.data);
    const entry = arr(body.alexandria)[0] ?? {};
    const creditsUsed = Number(entry.creditsCost ?? body.creditsCost ?? 0) || 0;
    const error = rec(entry.error);
    if (Object.keys(error).length > 0) {
      if (error.code === "not_found" || error.status === 404) {
        return { found: false, creditsUsed, data: {} };
      }
      throw new PeopleEnrichProviderError(
        `${provider}/${capability} failed: ${str(error.code) ?? "error"}: ${str(error.message) ?? "unknown"} (no credits charged: ${creditsUsed === 0})`,
        { endpoint: "/v2/scrape", status: Number(error.status) || undefined, code: str(error.code), creditsUsed },
      );
    }
    return { found: true, creditsUsed, data: rec(entry.data) };
  }

  /**
   * Paid calls are never retried on 5xx/timeouts to avoid double billing;
   * only 429 (rejected before running) is retried. Provider-reported free
   * timeouts are retried per step in cascade(), not here. Omitting body sends a GET.
   */
  private async requestJson(path: string, body?: Json): Promise<Json> {
    const endpoint = `/v2${path}`;
    const requestBody = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: requestBody === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: requestBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new PeopleEnrichConnectionError(error.message, { endpoint });
        }
        throw error;
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
        continue;
      }

      const text = await response.text().catch(() => "");
      const responseBody = text.slice(0, 500);
      const options = { endpoint, status: response.status, requestId, responseBody };

      if (response.ok) {
        return text ? (JSON.parse(text) as Json) : {};
      }
      if (response.status === 429) {
        throw new PeopleEnrichRateLimitError("People Enrich rate limit exceeded", options);
      }
      if (text.includes("THIRD_PARTY_DATA_TERMS_REQUIRED")) {
        const url = str(rec(rec(JSON.parse(text)).requiresAction).url);
        throw new PeopleEnrichTermsRequiredError(
          `An organization admin must accept this data provider's terms before it can be used${url ? `: ${url}` : ""}`,
          options,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new PeopleEnrichAuthError(`People Enrich authentication failed (${response.status}): ${responseBody}`, options);
      }
      if (response.status === 400 || response.status === 409 || response.status === 422) {
        throw new PeopleEnrichValidationError(`People Enrich rejected the request (${response.status}): ${responseBody}`, options);
      }
      if (response.status >= 500) {
        throw new PeopleEnrichServerError(`People Enrich server error (${response.status}): ${responseBody}`, options);
      }
      throw new PeopleEnrichError(`People Enrich request failed (${response.status}): ${responseBody}`, options);
    }

    throw new PeopleEnrichRateLimitError("People Enrich rate limit exceeded", { endpoint, status: 429 });
  }
}
