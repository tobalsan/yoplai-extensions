import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import type { ResolvedOAuth } from "../tool-extension.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const connected: ResolvedOAuth = { connected: true, provider: "google", accessToken: "test-token", account: "editor@example.com", scopes: [] };
function tools(oauth: ResolvedOAuth | undefined = connected, merged = {}) { return extension.createTools({ global: {}, agent: {}, merged, oauth }); }
function tool(name: string, oauth?: ResolvedOAuth) {
  const result = tools(oauth).find(candidate => candidate.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Google Analytics tools with mocked Google HTTP", () => {
  it.each(["", "abc", "ftp://example.com/a", "https://", "https:///", "?query=1", "//example.com/a"])("rejects invalid exact page %j before HTTP", async pagePath => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("unexpected HTTP"));
    vi.stubGlobal("fetch", fetcher);
    await expect(tool("compare_periods").execute({ property: "10", pagePaths: [pagePath] })).rejects.toThrow("Each pagePaths entry must be an absolute path or a valid HTTP(S) URL");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts absolute paths and HTTP(S) page URLs for the exact-page lookup", async () => {
    vi.stubGlobal("fetch", async (input: string) => json(input.endsWith("/userinfo") ? { email: "editor@example.com" } : {}));
    expect(await tool("compare_periods").execute({ property: "10", pagePaths: ["/", "/features/x/?query=1#section", "https://example.com/blog/post/?query=1", "http://example.com/glossary/word#section"] })).toMatchObject({ meta: { pagePathsWithoutData: ["/", "/features/x", "/blog/post", "/glossary/word"] }, rows: [{ pagePath: "/" }, { pagePath: "/features/x" }, { pagePath: "/blog/post" }, { pagePath: "/glossary/word" }] });
  });
  it.each([
    ["contains", "CONTAINS"], ["beginsWith", "BEGINS_WITH"], ["endsWith", "ENDS_WITH"], ["partialRegex", "PARTIAL_REGEXP"], ["fullRegex", "FULL_REGEXP"],
  ])("maps %s dimension filters to GA4 %s", async (match, matchType) => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(JSON.parse(String(init.body))).toMatchObject({ dimensionFilter: { andGroup: { expressions: [{ filter: { fieldName: "landingPage", stringFilter: { matchType, value: "/blog", caseSensitive: false } } }] } } });
      return json({});
    });
    expect(await tool("run_report").execute({ property: "10", dimensions: ["landingPage"], metrics: ["sessions"], dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-28" }], dimensionFilters: [{ field: "landingPage", match, value: "/blog" }] })).toMatchObject({ rows: [], nextOffset: null });
  });
  it.each([["eq", "EQUAL"], ["lt", "LESS_THAN"], ["lte", "LESS_THAN_OR_EQUAL"], ["gte", "GREATER_THAN_OR_EQUAL"]])("maps %s numeric filters to GA4 %s", async (operation, wireOperation) => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(JSON.parse(String(init.body))).toMatchObject({ metricFilter: { andGroup: { expressions: [{ filter: { fieldName: "sessions", numericFilter: { operation: wireOperation, value: { doubleValue: 5 } } } }] } } });
      return json({});
    });
    expect(await tool("run_report").execute({ property: "10", metrics: ["sessions"], dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-28" }], metricFilters: [{ field: "sessions", operation, value: 5 }] })).toMatchObject({ rows: [], nextOffset: null });
  });
  it("declares only read-only scopes and returns schema-valid successes for all four tools", async () => {
    expect(extension.oauth).toEqual({ provider: "google", scopes: ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/userinfo.email"] });
    expect(tools().map(selected => selected.name).sort()).toEqual(["compare_periods", "describe_property", "list_properties", "run_report"]);
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      if (input.endsWith("/keyEvents")) return json({ keyEvents: [{ eventName: "signup", custom: true, countingMethod: "ONCE_PER_EVENT" }] });
      if (input.endsWith(":runReport")) {
        const body = JSON.parse(String(init.body));
        return json({ dimensionHeaders: body.dimensions, metricHeaders: body.metrics, rows: [{ dimensionValues: body.dimensions.map(() => ({ value: "/blog/post" })), metricValues: body.metrics.map(() => ({ value: "1" })) }], totals: [{ metricValues: body.metrics.map(() => ({ value: "1" })) }], rowCount: 1, metadata: { timeZone: "UTC", currencyCode: "USD" } });
      }
      return json({ displayName: "Site", timeZone: "UTC", currencyCode: "USD" });
    });
    const values: Record<string, unknown> = { list_properties: {}, describe_property: { property: "10" }, compare_periods: { property: "10", keyEvents: ["signup"], current: { startDate: "2026-09-01", endDate: "2026-09-28" } }, run_report: { property: "10", dimensions: ["landingPage"], metrics: ["sessions"], dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-28" }] } };
    for (const selected of tools()) {
      expect(selected.annotations).toEqual({ readOnlyHint: true });
      expect(selected.outputSchema).toBeDefined();
      expect(selected.outputSchema?.safeParse(await selected.execute(values[selected.name])).success).toBe(true);
    }
  });
  it.each(["not_connected", "provider_not_configured", "expired", "needs_reconnect", "insufficient_scope"] as const)("preserves host-resolved %s for every tool without HTTP", async reason => {
    vi.stubGlobal("fetch", async () => { throw new Error("unexpected HTTP"); });
    const oauth: ResolvedOAuth = { connected: false, provider: "google", reason, message: "Host reconnect instructions", authorizeUrl: "/connect/google" };
    for (const selected of tools(oauth)) expect(await selected.execute({})).toEqual({ ...oauth, isError: true });
    for (const selected of extension.createTools({ global: {}, agent: {}, merged: {} })) expect(await selected.execute({})).toMatchObject({ isError: true, reason: "not_connected", message: expect.stringContaining("Just me or Whole team") });
  });
  it.each([
    [401, "Invalid Credentials", "expired"],
    [429, "Too many requests", "rate_limited"],
    [403, "Quota exceeded", "rate_limited"],
    [403, "RESOURCE_EXHAUSTED", "rate_limited"],
    [403, "Request had insufficient authentication scopes.", "insufficient_scope"],
  ])("returns an actionable refusal for HTTP %s: %s", async (status, message, reason) => {
    vi.stubGlobal("fetch", async (input: string) => input.endsWith("/userinfo") ? json({ email: "editor@example.com" }) : json({ error: { message } }, status));
    expect(await tool("list_properties").execute({})).toEqual({ isError: true, connected: false, provider: "google", reason, message: expect.any(String), authorizeUrl: "/agents" });
  });
  it.each(["User does not have sufficient permissions for this property.", "Analytics Data API has not been used in project 123 before or it is disabled.", "Analytics Admin API is disabled."])("throws setup guidance for non-scope 403: %s", async message => {
    vi.stubGlobal("fetch", async (input: string) => input.endsWith("/userinfo") ? json({ email: "editor@example.com" }) : json({ error: { message } }, 403));
    await expect(tool("describe_property").execute({ property: "10" })).rejects.toThrow(/Viewer.*properties\/10.*Analytics Data API.*Analytics Admin API/);
  });
  it("refuses the wrong connected account before requesting property data", async () => {
    vi.stubGlobal("fetch", async (input: string) => { expect(input).toBe("https://www.googleapis.com/oauth2/v2/userinfo"); return json({ email: "other@example.com" }); });
    expect(await tool("list_properties").execute({}, { agentId: "content agent" })).toMatchObject({ isError: true, connected: false, provider: "google", reason: "wrong_account", authorizeUrl: "/agents/content%20agent/extensions/googleAnalytics" });
  });
  it("times out a hanging request and lets a subsequent read progress", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    const selected = tool("list_properties");
    const pending = expect(selected.execute({})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(await selected.execute({})).toEqual({ properties: [], account: "editor@example.com" });
  });
  it("surfaces ordinary API failures and permits a following read", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({ error: { message: "Invalid dimension" } }, 400)).mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(tool("list_properties").execute({})).rejects.toThrow("Invalid dimension");
    expect(await tool("list_properties").execute({})).toMatchObject({ properties: [] });
  });
  it("rejects invalid inputs before making HTTP requests", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("unexpected HTTP"); });
    for (const dateRanges of [[{ startDate: "2026-02-30", endDate: "2026-03-01" }], [{ startDate: "2026-09-02", endDate: "2026-09-01" }]]) await expect(tool("run_report").execute({ property: "10", metrics: ["sessions"], dateRanges })).rejects.toThrow();
    await expect(tool("compare_periods").execute({ property: "10", pagePaths: Array.from({ length: 501 }, (_, index) => `/page-${index}`) })).rejects.toThrow();
    await expect(tool("describe_property").execute({ property: "../accounts/1" })).rejects.toThrow();
    await expect(tool("list_properties").execute({ unexpected: true })).rejects.toThrow();
  });
  it("keeps traffic metadata available when no key events have been configured", async () => {
    vi.stubGlobal("fetch", async (input: string) => json(input.endsWith("/userinfo") ? { email: "editor@example.com" } : {}));
    expect(await tool("describe_property").execute({ property: "10" })).toMatchObject({ keyEvents: [], warnings: ["No key events are configured: conversion data unavailable"] });
  });
  it("warns about processing delay for recent report dates in the property calendar", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T01:00:00Z"));
    vi.stubGlobal("fetch", async (input: string) => json(input.endsWith("/userinfo") ? { email: "editor@example.com" } : { metadata: { timeZone: "Asia/Tokyo" } }));
    expect(await tool("run_report").execute({ property: "10", metrics: ["sessions"], dateRanges: [{ startDate: "2026-10-26", endDate: "2026-10-26" }] })).toMatchObject({ nextOffset: null, meta: { warnings: [expect.stringMatching(/processing delay/i)] } });
  });
  it("gets the property calendar before comparing separate complete default periods", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T01:00:00Z"));
    const periods: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      if (input.endsWith("/properties/10")) return json({ timeZone: "Asia/Tokyo" });
      if (input.endsWith("/keyEvents")) return json({ keyEvents: [] });
      expect(input).toBe("https://analyticsdata.googleapis.com/v1beta/properties/10:runReport");
      const body = JSON.parse(String(init.body)); periods.push(body.dateRanges);
      expect(body.dimensions).toEqual([{ name: "landingPage" }]);
      return json({ rows: [] });
    });
    const result = await tool("compare_periods").execute({ property: "10" });
    expect(result).toMatchObject({ account: "editor@example.com", meta: { current: { startDate: "2026-09-28", endDate: "2026-10-25" }, previous: { startDate: "2026-08-31", endDate: "2026-09-27" } } });
    expect(periods).toEqual([[{ startDate: "2026-09-28", endDate: "2026-10-25" }], [{ startDate: "2026-08-31", endDate: "2026-09-27" }]]);
  });
  it("runs paged ad-hoc reports with AND filters, numeric metrics and a dateRange dimension", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://analyticsdata.googleapis.com/v1beta/properties/10:runReport");
      expect(JSON.parse(String(init.body))).toEqual({ dimensions: [{ name: "country" }], metrics: [{ name: "sessions" }], dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-28" }, { startDate: "2026-08-04", endDate: "2026-08-31" }], dimensionFilter: { andGroup: { expressions: [{ filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "United States", caseSensitive: false } } }, { notExpression: { filter: { fieldName: "sessionSource", inListFilter: { values: ["spam.example"], caseSensitive: true } } } }] } }, metricFilter: { andGroup: { expressions: [{ filter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 5 } } } }] } }, orderBys: [{ metric: { metricName: "sessions" }, desc: true }, { dimension: { dimensionName: "country" }, desc: false }], limit: 1, offset: 2 });
      return json({ dimensionHeaders: [{ name: "country" }, { name: "dateRange" }], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "United States" }, { value: "date_range_0" }], metricValues: [{ value: "12" }] }], rowCount: 4, metadata: { timeZone: "America/New_York", currencyCode: "USD", subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "200" }] } });
    });
    expect(await tool("run_report").execute({ property: "properties/10", dimensions: ["country"], metrics: ["sessions"], dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-28" }, { startDate: "2026-08-04", endDate: "2026-08-31" }], dimensionFilters: [{ field: "country", match: "exact", value: "United States" }, { field: "sessionSource", match: "in", values: ["spam.example"], not: true, caseSensitive: true }], metricFilters: [{ field: "sessions", operation: "gt", value: 5 }], orderBys: [{ field: "sessions", desc: true }, { field: "country" }], limit: 1, offset: 2 })).toMatchObject({ account: "editor@example.com", rows: [{ dimensions: { country: "United States", dateRange: "date_range_0" }, metrics: { sessions: 12 } }], rowCount: 4, nextOffset: 3, meta: { timezone: "America/New_York", currency: "USD", subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "200" }], warnings: [expect.stringMatching(/threshold/i), expect.stringMatching(/other/i)] } });
  });
  it("describes property settings, paginated key events and only custom metadata", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      if (input === "https://analyticsadmin.googleapis.com/v1beta/properties/10") return json({ displayName: "Site", timeZone: "Asia/Tokyo", currencyCode: "JPY" });
      if (input.endsWith("/keyEvents")) return json({ keyEvents: [{ eventName: "signup", countingMethod: "ONCE_PER_EVENT", custom: true }], nextPageToken: "next" });
      if (input.endsWith("/keyEvents?pageToken=next")) return json({ keyEvents: [{ eventName: "purchase", countingMethod: "ONCE_PER_SESSION", custom: false }] });
      expect(input).toBe("https://analyticsdata.googleapis.com/v1beta/properties/10/metadata");
      return json({ dimensions: [{ apiName: "country", uiName: "Country" }, { apiName: "customEvent:tier", uiName: "Tier", description: "Account tier", customDefinition: true, scope: "EVENT" }], metrics: [{ apiName: "customEvent:value", uiName: "Value", customDefinition: true }] });
    });
    expect(await tool("describe_property").execute({ property: "10" })).toEqual({ account: "editor@example.com", property: "properties/10", displayName: "Site", timeZone: "Asia/Tokyo", currencyCode: "JPY", keyEvents: [{ eventName: "signup", countingMethod: "ONCE_PER_EVENT", custom: true }, { eventName: "purchase", countingMethod: "ONCE_PER_SESSION", custom: false }], customDimensions: [{ apiName: "customEvent:tier", uiName: "Tier", description: "Account tier", scope: "EVENT" }], customMetrics: [{ apiName: "customEvent:value", uiName: "Value", description: null, scope: null }], warnings: [] });
  });
  it("lists all visible properties with their account after paginating account summaries", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
      if (input.endsWith("/userinfo")) return json({ email: "EDITOR@example.com" });
      if (input === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") return json({ accountSummaries: [{ account: "accounts/1", displayName: "First", propertySummaries: [{ property: "properties/10", displayName: "Site" }] }], nextPageToken: "second" });
      expect(input).toBe("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageToken=second");
      return json({ accountSummaries: [{ account: "accounts/2", displayName: "Second", propertySummaries: [{ property: "properties/20", displayName: "Other" }] }] });
    });
    expect(await tool("list_properties").execute({})).toEqual({ account: "EDITOR@example.com", properties: [{ property: "properties/10", displayName: "Site", account: "accounts/1", accountDisplayName: "First" }, { property: "properties/20", displayName: "Other", account: "accounts/2", accountDisplayName: "Second" }] });
  });
});
