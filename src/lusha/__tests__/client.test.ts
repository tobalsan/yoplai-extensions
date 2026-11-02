import { afterEach, describe, expect, it, vi } from "vitest";
import { LushaClient } from "../client.js";
import { LushaAuthError, LushaConnectionError, LushaOutOfCreditsError, LushaRateLimitError, LushaServerError, LushaValidationError } from "../errors.js";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const linkedin = { linkedinUrl: "https://www.linkedin.com/in/alex-example" };

describe("Lusha enrichment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reveals only emails for one contact and reports the billed cost and profile", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [{
        id: "person-1", firstName: "Alex", lastName: "Example", fullName: "Alex Example",
        jobTitle: { title: "Director" }, company: { name: "Example", domain: "example.com" },
        emails: [{ email: "alex@example.com", type: "work", confidence: "A+" }],
      }],
      billing: { creditsCharged: 2, resultsReturned: 1 },
    }));

    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails")).resolves.toMatchObject({
      found: true, creditsUsed: 2,
      emails: [{ email: "alex@example.com", type: "work", confidence: "A+" }],
      person: { fullName: "Alex Example", jobTitle: { title: "Director" }, company: { domain: "example.com" } },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.lusha.com/v3/contacts/search-and-enrich");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST", headers: { api_key: "test-key", "content-type": "application/json" },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      contacts: [{ linkedinUrl: "https://www.linkedin.com/in/alex-example" }], reveal: ["emails"],
    });
  });
  it("reveals only phones using name and company identifiers, retaining doNotCall", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [{ fullName: "Alex Example", phones: [{ number: "+12025550123", type: "mobile", doNotCall: true }] }],
      billing: { creditsCharged: 6 },
    }));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson({
      firstName: "Alex", lastName: "Example", companyName: "Example",
    }, "phones")).resolves.toMatchObject({
      found: true, creditsUsed: 6, phones: [{ number: "+12025550123", type: "mobile", doNotCall: true }],
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      contacts: [{ firstName: "Alex", lastName: "Example", companyName: "Example" }], reveal: ["phones"],
    });
  });
  it.each([
    [{ error: { code: "NOT_FOUND" } }, { found: false, errorCode: "NOT_FOUND" }],
    [{ id: "person-1", emails: [] }, { found: false }],
    [{ id: "person-1" }, { found: false }],
    [{ error: { code: "COMPLIANCE_RESTRICTED" } }, { found: false, reason: "Legal restriction", errorCode: "COMPLIANCE_RESTRICTED" }],
    [{ error: { code: "ENRICH_FAILED" } }, { found: false, errorCode: "ENRICH_FAILED" }],
  ])("returns a normal missing-data outcome for %j", async (result, expected) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [result], billing: { creditsCharged: 0, status: "PARTIAL_OUT_OF_CREDITS", lowBalance: true },
    }));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails")).resolves.toMatchObject({
      ...expected, creditsUsed: 0, emails: [], billingStatus: "PARTIAL_OUT_OF_CREDITS", lowBalance: true,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it("distinguishes a missing reveal caused by exhausted waterfall credits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [{ id: "person-1", missingDataPoints: [{ type: "phone", status: "BILLING_FAILED", description: "Balance exhausted" }] }],
      billing: { creditsCharged: 1, status: "OUT_OF_CREDITS" },
    }));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "phones")).resolves.toMatchObject({
      found: false, creditsUsed: 1, phones: [], billingStatus: "OUT_OF_CREDITS",
      missingDataPoints: [{ type: "phone", status: "BILLING_FAILED", description: "Balance exhausted" }],
    });
  });
  it.each([{}, { firstName: "Alex", lastName: "Example" }, { companyDomain: "example.com" },
    { firstName: " ", lastName: "Example", companyName: "Example" }, { linkedinUrl: "invalid" },
  ])("rejects incomplete identifiers before making a paid request: %j", async (input) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(input, "emails")).rejects.toBeInstanceOf(LushaValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    [401, LushaAuthError], [403, LushaAuthError], [402, LushaOutOfCreditsError],
    [400, LushaValidationError], [412, LushaValidationError], [422, LushaValidationError],
    [499, LushaServerError], [500, LushaServerError], [503, LushaServerError],
  ])("reports HTTP %i without repeating the billed request", async (status, ErrorClass) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ message: "Request failed" }, status));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails")).rejects.toBeInstanceOf(ErrorClass);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it("returns an HTTP legal restriction as a normal unbilled outcome", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "GDPR restriction" }, 451));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails")).resolves.toMatchObject({
      found: false, creditsUsed: 0, emails: [], reason: "Legal restriction", errorCode: "COMPLIANCE_RESTRICTED",
    });
  });
  it.each(["2", "Mon, 02 Nov 2026 12:00:02 GMT"])("bounds rate-limit retries and respects Retry-After %s", async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}, 429, {
      "retry-after": retryAfter.startsWith("Mon") ? new Date(Date.now() + 2000).toUTCString() : retryAfter,
    }));
    const outcome = new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toBeInstanceOf(LushaRateLimitError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it("times out a hanging fetch without retrying and allows the next lookup to proceed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })).mockResolvedValue(jsonResponse({ results: [], billing: { creditsCharged: 0 } }));
    const client = new LushaClient({ apiKey: "test-key", timeoutMs: 10 });
    await expect(client.findPerson(linkedin, "emails")).rejects.toBeInstanceOf(LushaConnectionError);
    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(client.findPerson(linkedin, "emails")).resolves.toMatchObject({ found: false, creditsUsed: 0 });
  });
  it("looks up one company with full compact firmographics and the billed cost", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [{ id: "company-1", name: "Example", domain: "example.com", industry: "Software",
        employeeCount: { exact: 364, min: 201, max: 500 }, location: { city: "London", country: "United Kingdom" },
        description: "Example company", yearFounded: 2016, socialLinks: { linkedin: "https://www.linkedin.com/company/example" },
      }], billing: { creditsCharged: 1 },
    }));
    await expect(new LushaClient({ apiKey: "test-key" }).findCompany({ domain: "example.com" })).resolves.toMatchObject({
      found: true, creditsUsed: 1, company: {
        name: "Example", domain: "example.com", industry: "Software", employeeCount: { exact: 364, min: 201, max: 500 },
        location: { city: "London", country: "United Kingdom" }, description: "Example company", yearFounded: 2016,
        socialLinks: { linkedin: "https://www.linkedin.com/company/example" },
      },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.lusha.com/v3/companies/search-and-enrich");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ companies: [{ domain: "example.com" }] });
  });
  it("reads the free V3 account balance, renewal date and plan-specific action pricing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      credits: { total: 802, used: 9, remaining: 793 }, plan: { category: "premium", endDate: "2026-12-01" },
      rateLimits: { minute: { limit: 5, remaining: 4 } },
      pricing: { contactSearch: { credits: 1, perQuantity: 25 }, revealPhone: { credits: 5, perQuantity: 1 } },
    }));
    await expect(new LushaClient({ apiKey: "test-key" }).accountUsage()).resolves.toMatchObject({
      credits: { total: 802, used: 9, remaining: 793 }, plan: { category: "premium", endDate: "2026-12-01" },
      pricing: { contactSearch: { credits: 1, perQuantity: 25 }, revealPhone: { credits: 5, perQuantity: 1 } },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.lusha.com/v3/account/usage");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { api_key: "test-key" } });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it("validates via the free usage endpoint and reports authentication failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      credits: { total: 802, used: 9, remaining: 793 }, plan: { endDate: "2026-12-01" }, pricing: {},
    })).mockResolvedValueOnce(jsonResponse({}, 401));
    const client = new LushaClient({ apiKey: "test-key" });
    await expect(client.validate()).resolves.toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.lusha.com/v3/account/usage");
    await expect(client.validate()).rejects.toBeInstanceOf(LushaAuthError);
  });
  it.each([499, 500, 503])("does not repeat a billed company lookup after HTTP %i", async (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, status));
    await expect(new LushaClient({ apiKey: "test-key" }).findCompany({ name: "Example" })).rejects.toBeInstanceOf(LushaServerError);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ companies: [{ name: "Example" }] });
  });

  it("reports fetch failures without retrying a paid lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network unavailable"));
    await expect(new LushaClient({ apiKey: "test-key" }).findPerson(linkedin, "emails")).rejects.toBeInstanceOf(LushaConnectionError);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("defers a long Retry-After to the caller without retrying early", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 429, { "retry-after": "3600" }));
    await expect(new LushaClient({ apiKey: "test-key" }).accountUsage()).rejects.toBeInstanceOf(LushaRateLimitError);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([{}, { name: " " }])("rejects missing company identifiers before fetch: %j", async (input) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(new LushaClient({ apiKey: "test-key" }).findCompany(input)).rejects.toBeInstanceOf(LushaValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [200, { results: [{ error: { code: "NOT_FOUND" } }], billing: { creditsCharged: 0 } }, { found: false, creditsUsed: 0 }],
    [200, { results: [{ error: { code: "COMPLIANCE_RESTRICTED" } }], billing: { creditsCharged: 0 } }, { found: false, reason: "Legal restriction" }],
    [451, {}, { found: false, reason: "Legal restriction", creditsUsed: 0 }],
  ])("returns missing or legally restricted company outcomes normally (HTTP %i)", async (status, body, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, status));
    await expect(new LushaClient({ apiKey: "test-key" }).findCompany({ name: "Example" })).resolves.toMatchObject(expected);
  });
});
