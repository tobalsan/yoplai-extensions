import { afterEach, describe, expect, it, vi } from "vitest";

import { PeopleEnrichClient } from "../client.js";
import { PeopleEnrichAuthError, PeopleEnrichConnectionError, PeopleEnrichValidationError } from "../errors.js";

function entry(provider: string, capability: string, creditsCost: number, extra: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ success: true, data: { alexandria: [{ provider, capability, creditsCost, ...extra }], creditsCost } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const client = new PeopleEnrichClient({ apiKey: "k", timeoutMs: 1000, retryDelayMs: 0 });

function mockFetch(...responses: Response[]) {
  const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected extra fetch"));
  for (const response of responses) spy.mockResolvedValueOnce(response);
  return spy;
}

function sentBody(spy: ReturnType<typeof mockFetch>, call = 0) {
  return JSON.parse(String(spy.mock.calls[call][1]?.body));
}

describe("PeopleEnrichClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("searches people via the free catalog capability", async () => {
    const spy = mockFetch(
      entry("apollo", "people/search", 0, {
        data: {
          total_entries: 1,
          people: [
            {
              id: "abc",
              first_name: "Eric",
              last_name_obfuscated: "In***d",
              title: "Chief Marketing Officer",
              has_email: true,
              has_direct_phone: "Maybe: please request direct dial via people/bulk_match",
              organization: { name: "Acme" },
            },
          ],
        },
      }),
    );
    const result = await client.searchPeople({ name: "Eric Ingrand" });
    expect(spy.mock.calls[0][0]).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(sentBody(spy)).toEqual({
      alexandria: { provider: "apollo", capability: "people/search", options: { q_keywords: "Eric Ingrand", per_page: 25 } },
    });
    expect(result).toEqual({
      provider: "apollo",
      creditsUsed: 0,
      totalMatches: 1,
      people: [
        {
          apolloId: "abc",
          firstName: "Eric",
          lastNameMasked: "In***d",
          title: "Chief Marketing Officer",
          company: "Acme",
          hasEmail: true,
          hasDirectPhone: "maybe",
        },
      ],
    });
  });

  it("returns a found work email without calling the fallback", async () => {
    const spy = mockFetch(
      entry("fullenrich", "contacts/work-email", 20, {
        data: {
          results: [
            {
              contact_info: {
                most_probable_work_email: { email: "jane@acme.com", status: "DELIVERABLE" },
                work_emails: [{ email: "jane@acme.com", status: "DELIVERABLE" }],
              },
              profile: {
                full_name: "Jane Doe",
                headline: "CTO",
                location: { city: "Paris", country: "France" },
                employment: {
                  current: { title: "CTO", company: { name: "Acme", domain: "acme.com" } },
                  all: [{ title: "CTO", company: { name: "Acme" }, start_at: "2022-01-01T00:00:00Z", is_current: true }],
                },
              },
            },
          ],
        },
      }),
    );
    const result = await client.findWorkEmail({
      linkedinUrl: "https://linkedin.com/in/jane",
      apolloId: "abc",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      found: true,
      email: "jane@acme.com",
      emailStatus: "DELIVERABLE",
      creditsUsed: 20,
      person: { name: "Jane Doe", location: "Paris, France", currentCompanyDomain: "acme.com" },
    });
    expect((result.person as { experience: unknown[] }).experience).toEqual([
      { title: "CTO", company: "Acme", start: "2022-01", end: "present" },
    ]);
  });

  it("falls back to Apollo when the primary provider has no email", async () => {
    const spy = mockFetch(
      entry("fullenrich", "contacts/work-email", 0, { error: { code: "not_found", message: "none", status: 404 } }),
      entry("apollo", "people/bulk-match", 30, {
        data: { matches: [{ id: "abc", name: "Jane Doe", email: "jane@acme.com", email_status: "verified" }] },
      }),
    );
    const result = await client.findWorkEmail({
      firstName: "Jane",
      lastName: "Doe",
      companyDomain: "https://www.acme.com/",
      apolloId: "abc",
    });
    expect(sentBody(spy, 0).alexandria.options).toEqual({ first_name: "Jane", last_name: "Doe", domain: "acme.com" });
    expect(sentBody(spy, 1).alexandria).toEqual({
      provider: "apollo",
      capability: "people/bulk-match",
      options: { details: [{ id: "abc" }] },
    });
    expect(result).toMatchObject({ found: true, provider: "apollo", email: "jane@acme.com", creditsUsed: 30 });
    expect(result.attempts).toHaveLength(2);
  });

  it("treats Apollo's locked-email placeholder as no email and keeps cascading", async () => {
    mockFetch(
      entry("fullenrich", "contacts/work-email", 0, { error: { code: "not_found", status: 404 } }),
      entry("apollo", "people/bulk-match", 30, {
        data: { matches: [{ id: "abc", name: "Jane Doe", email: "email_not_unlocked@acme.com" }] },
      }),
      entry("datalegion", "people/enrich-base-with-contact", 0, { error: { code: "not_found", status: 404 } }),
    );
    const result = await client.findWorkEmail({ linkedinUrl: "https://linkedin.com/in/jane", apolloId: "abc" });
    expect(result).toMatchObject({ found: false, email: null, creditsUsed: 30 });
    expect((result.attempts as unknown[]).map((attempt) => (attempt as { provider: string }).provider)).toEqual([
      "fullenrich",
      "apollo",
      "datalegion",
    ]);
  });

  it("uses Apollo as a last-resort profile source without exposing its email", async () => {
    const spy = mockFetch(
      entry("fullenrich", "people/lookup", 0, { data: { people: [] } }),
      entry("datalegion", "people/enrich-base-no-contact", 0, { error: { code: "not_found", status: 404 } }),
      entry("apollo", "people/bulk-match", 30, {
        data: { matches: [{ id: "abc", name: "Jane Doe", title: "CTO", email: "jane@acme.com", email_status: "verified" }] },
      }),
    );
    const result = await client.lookupPerson({ name: "Jane Doe", companyDomain: "acme.com" });
    expect(sentBody(spy, 2).alexandria.options).toEqual({ details: [{ name: "Jane Doe", domain: "acme.com" }] });
    expect(result).toMatchObject({ found: true, provider: "apollo", creditsUsed: 30, person: { name: "Jane Doe" } });
    expect(result.person).not.toHaveProperty("email");
  });

  it("validates identifiers before spending credits", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(client.findWorkEmail({ firstName: "Jane" })).rejects.toBeInstanceOf(PeopleEnrichValidationError);
    await expect(client.lookupPerson({ name: "Jane Doe" })).rejects.toBeInstanceOf(PeopleEnrichValidationError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns a mobile from the cheap source without calling the expensive one", async () => {
    const spy = mockFetch(
      entry("datalegion", "people/enrich-base-with-contact", 50, {
        data: {
          matches: [
            {
              person: {
                full_name: "Jane Doe",
                mobile_phone: "+33600000000",
                phones: [{ type: "mobile", number: "+33600000000", confidence: "high" }],
              },
            },
          ],
        },
      }),
    );
    const result = await client.findMobile({ linkedinUrl: "https://linkedin.com/in/jane", confirmCost: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy).alexandria.options).toMatchObject({
      social_url: "https://linkedin.com/in/jane",
      required_fields: "phones.type:mobile",
      min_confidence: "high",
    });
    expect(result).toMatchObject({ found: true, provider: "datalegion", phone: "+33600000000", creditsUsed: 50 });
  });

  it("falls back to the expensive mobile source when the cheap one misses", async () => {
    mockFetch(
      entry("datalegion", "people/enrich-base-with-contact", 0, { error: { code: "not_found", status: 404 } }),
      entry("fullenrich", "contacts/mobile", 175, {
        data: {
          results: [
            {
              contact_info: {
                most_probable_phone: { number: "+33 6 00 00 00 00", region: "FR", line_type: "MOBILE", line_status: "ACTIVE" },
                phones: [{ number: "+33 6 00 00 00 00", region: "FR", line_type: "MOBILE", line_status: "ACTIVE" }],
              },
            },
          ],
        },
      }),
    );
    const result = await client.findMobile({ linkedinUrl: "https://linkedin.com/in/jane", confirmCost: true });
    expect(result).toMatchObject({ found: true, provider: "fullenrich", phone: "+33 6 00 00 00 00", creditsUsed: 175 });
  });

  it("records unbilled provider errors and moves to the next source", async () => {
    mockFetch(
      entry("datalegion", "people/enrich-base-no-contact", 0, {
        error: { code: "provider_rate_limited", message: "The data source is at capacity.", status: 429 },
      }),
      entry("fullenrich", "contacts/reverse-email", 20, {
        data: { results: [{ profile: { full_name: "Jane Doe" } }] },
      }),
    );
    const result = await client.reverseEmail({ email: "jane@acme.com" });
    expect(result).toMatchObject({ found: true, provider: "fullenrich", creditsUsed: 20, person: { name: "Jane Doe" } });
    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: "datalegion", found: false, error: expect.stringContaining("provider_rate_limited") }),
      { provider: "fullenrich", creditsUsed: 20, found: true },
    ]);
  });

  it("uses the last-resort work email source, filtered to bill only when an email exists", async () => {
    const spy = mockFetch(
      entry("fullenrich", "contacts/work-email", 0, { error: { code: "not_found", status: 404 } }),
      entry("datalegion", "people/enrich-base-with-contact", 50, {
        data: {
          matches: [
            {
              person: {
                full_name: "Jane Doe",
                work_email: "jane@acme.com",
                emails: [{ address: "jane@acme.com", type: "professional", validated: true }],
                experience: [{ title: { cleaned: "CTO" }, organization: { name: { cleaned: "Acme" } }, current: true }],
              },
            },
          ],
        },
      }),
    );
    const result = await client.findWorkEmail({ linkedinUrl: "https://linkedin.com/in/jane" });
    expect(sentBody(spy, 1).alexandria.options).toMatchObject({
      required_fields: "work_email",
      exclude_fields: "phones,mobile_phone",
    });
    expect(result).toMatchObject({
      found: true,
      provider: "datalegion",
      email: "jane@acme.com",
      emailStatus: "validated",
      creditsUsed: 50,
      person: { name: "Jane Doe", experience: [{ title: "CTO", company: "Acme", end: "present" }] },
    });
  });

  it("skips a source whose terms are not accepted", async () => {
    mockFetch(
      entry("fullenrich", "companies/lookup", 0, { error: { code: "not_found", status: 404 } }),
      new Response(
        JSON.stringify({
          success: false,
          code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
          requiresAction: { type: "accept_terms", url: "https://example.com/terms" },
        }),
        { status: 403 },
      ),
      entry("apollo", "companies/bulk-enrich", 30, {
        data: { organizations: [{ name: "Acme", primary_domain: "acme.com", estimated_num_employees: 40 }] },
      }),
    );
    const result = await client.lookupCompany({ domain: "acme.com" });
    expect(result).toMatchObject({ found: true, provider: "apollo", company: { name: "Acme", domain: "acme.com" } });
    expect(String((result.attempts as Array<{ error?: string }>)[1].error)).toContain("https://example.com/terms");
  });

  it("does not retry paid calls on server errors", async () => {
    const spy = mockFetch(
      new Response("boom", { status: 502 }),
      new Response("boom", { status: 502 }),
      entry("apollo", "people/bulk-match", 0, { data: { matches: [null] } }),
    );
    const result = await client.reverseEmail({ email: "a@b.com" });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ found: false, creditsUsed: 0 });
    expect(String((result.attempts as Array<{ error?: string }>)[0].error)).toContain("502");
  });

  it("aborts the cascade on authentication failures", async () => {
    mockFetch(new Response("bad key", { status: 401 }));
    await expect(client.lookupCompany({ domain: "acme.com" })).rejects.toBeInstanceOf(PeopleEnrichAuthError);
  });

  it("validates via the free catalog search", async () => {
    const spy = mockFetch(new Response(JSON.stringify({ success: true, data: { tools: [] } }), { status: 200 }));
    expect(await client.validate()).toEqual({ ok: true });
    expect(spy.mock.calls[0][0]).toBe("https://api.firecrawl.dev/v2/search");
  });

  describe("provider timeout retries", () => {
    const timeout = (credits = 0) =>
      entry("fullenrich", "contacts/work-email", credits, {
        error: { code: "deadline_exceeded", message: "The request took too long.", status: 504 },
      });
    const emailHit = () =>
      entry("fullenrich", "contacts/work-email", 20, {
        data: { results: [{ contact_info: { most_probable_work_email: { email: "jane@acme.com" } } }] },
      });
    const miss = (provider: string, capability: string) =>
      entry(provider, capability, 0, { error: { code: "not_found", status: 404 } });
    const params = { linkedinUrl: "https://linkedin.com/in/jane" };

    it("retries a free timeout and stops when the retry finds the email", async () => {
      const spy = mockFetch(timeout(), emailHit());
      const result = await client.findWorkEmail(params);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ found: true, provider: "fullenrich", email: "jane@acme.com", creditsUsed: 20 });
      expect(result.attempts).toEqual([{ provider: "fullenrich", creditsUsed: 20, found: true, retries: 1 }]);
    });

    it("tries a timing-out step 3 times, then falls through", async () => {
      const spy = mockFetch(
        timeout(),
        timeout(),
        timeout(),
        miss("datalegion", "people/enrich-base-with-contact"),
        entry("apollo", "people/bulk-match", 0, { data: { matches: [null] } }),
      );
      const result = await client.findWorkEmail(params);
      expect(spy).toHaveBeenCalledTimes(5);
      for (const call of [0, 1, 2]) expect(sentBody(spy, call).alexandria.provider).toBe("fullenrich");
      expect(sentBody(spy, 3).alexandria.provider).toBe("datalegion");
      const attempts = result.attempts as Array<Record<string, unknown>>;
      expect(attempts).toHaveLength(3);
      expect(attempts[0]).toMatchObject({ provider: "fullenrich", creditsUsed: 0, found: false, retries: 2 });
      expect(attempts[1]).not.toHaveProperty("retries");
    });

    it("does not retry a timeout that charged credits", async () => {
      const spy = mockFetch(
        timeout(5),
        miss("datalegion", "people/enrich-base-with-contact"),
        entry("apollo", "people/bulk-match", 0, { data: { matches: [null] } }),
      );
      const result = await client.findWorkEmail(params);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ found: false, creditsUsed: 5 });
      expect((result.attempts as Array<Record<string, unknown>>)[0]).toMatchObject({ creditsUsed: 5 });
      expect((result.attempts as Array<Record<string, unknown>>)[0]).not.toHaveProperty("retries");
    });

    it("does not retry our own HTTP timeout and still aborts", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      await expect(client.findWorkEmail(params)).rejects.toBeInstanceOf(PeopleEnrichConnectionError);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("does not retry other provider errors", async () => {
      const spy = mockFetch(
        entry("fullenrich", "contacts/work-email", 0, { error: { code: "provider_error", message: "bad", status: 502 } }),
        miss("datalegion", "people/enrich-base-with-contact"),
        entry("apollo", "people/bulk-match", 0, { data: { matches: [null] } }),
      );
      const result = await client.findWorkEmail(params);
      expect(spy).toHaveBeenCalledTimes(3);
      expect((result.attempts as Array<Record<string, unknown>>)[0]).toMatchObject({ error: expect.stringContaining("provider_error") });
    });
  });

  it("reads credit usage with a free GET", async () => {
    const spy = mockFetch(
      new Response(
        JSON.stringify({
          success: true,
          data: { remainingCredits: 1000, planCredits: 5000, billingPeriodStart: "2025-01-01T00:00:00Z", billingPeriodEnd: "2025-02-01T00:00:00Z" },
        }),
        { status: 200 },
      ),
    );
    expect(await client.creditUsage()).toEqual({
      remainingCredits: 1000,
      planCredits: 5000,
      billingPeriodStart: "2025-01-01T00:00:00Z",
      billingPeriodEnd: "2025-02-01T00:00:00Z",
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("maps a credit usage 401 to an auth error", async () => {
    mockFetch(new Response("bad key", { status: 401 }));
    await expect(client.creditUsage()).rejects.toBeInstanceOf(PeopleEnrichAuthError);
  });
});
