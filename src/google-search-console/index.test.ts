import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import type { ResolvedOAuth } from "../tool-extension.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const connected: ResolvedOAuth = { connected: true, provider: "google", accessToken: "test-token", account: "editor@example.com", scopes: [] };
function tools(oauth: ResolvedOAuth | undefined = connected) {
  return extension.createTools({ global: {}, agent: {}, merged: {}, oauth });
}
function tool(name: string, oauth?: ResolvedOAuth) {
  const result = tools(oauth).find(candidate => candidate.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Search Console tools with mocked Google HTTP", () => {
  it("uses the Pacific clock and three-day lag for default comparison periods", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T01:00:00Z"));
    const periods: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      const body = JSON.parse(String(init.body)); periods.push({ startDate: body.startDate, endDate: body.endDate });
      return json({ rows: [] });
    });
    await tool("compare_periods").execute({ siteUrl: "sc-domain:example.com" });
    expect(periods).toEqual([{ startDate: "2026-09-27", endDate: "2026-10-24" }, { startDate: "2026-08-30", endDate: "2026-09-26" }]);
  });
  it("rejects non-page query enrichment and invalid inputs without a Search Analytics request", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      expect(input.endsWith("/userinfo")).toBe(true);
      return json({ email: "editor@example.com" });
    });
    await expect(tool("compare_periods").execute({ siteUrl: "sc-domain:example.com", dimension: "query", topQueries: 1 })).rejects.toThrow(/topQueries.*page/);
    await expect(tool("search_analytics").execute({ siteUrl: "sc-domain:example.com", startDate: "2026-02-30", endDate: "2026-03-01" })).rejects.toThrow();
    await expect(tool("search_analytics").execute({ siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-28", rowLimit: 25001 })).rejects.toThrow();
    await expect(tool("list_sites").execute({ extra: "unexpected" })).rejects.toThrow();
  });
  it("returns aggregate analytics rows with empty keys when no dimensions were requested", async () => {
    vi.stubGlobal("fetch", async (input: string) => json(input.endsWith("/userinfo") ? { email: "editor@example.com" } : { rows: [{ clicks: 7, impressions: 70, ctr: 0.1, position: 3 }] }));
    expect(await tool("search_analytics").execute({ siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-28" })).toMatchObject({ rows: [{ keys: [], clicks: 7, impressions: 70, ctr: 0.1, position: 3 }] });
  });
  it("preserves host-resolved disconnection signals for every tool without HTTP", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("unexpected HTTP"); });
    const oauth: ResolvedOAuth = { connected: false, provider: "google", reason: "insufficient_scope", message: "Approve Search Console access", authorizeUrl: "/connect/google" };
    for (const selected of tools(oauth)) expect(await selected.execute({})).toEqual({ ...oauth, isError: true });
    for (const selected of extension.createTools({ global: {}, agent: {}, merged: {} })) expect(await selected.execute({})).toMatchObject({ isError: true, reason: "not_connected", message: expect.stringContaining("Just me or Whole team") });
  });
  it("declares exactly the read-only scopes, tool annotations and success schemas", async () => {
    expect(extension.oauth).toEqual({ provider: "google", scopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/userinfo.email"] });
    expect(tools().map(selected => selected.name).sort()).toEqual(["compare_periods", "inspect_url", "list_sitemaps", "list_sites", "search_analytics"]);
    vi.stubGlobal("fetch", async (input: string) => json(input.endsWith("/userinfo") ? { email: "editor@example.com" } : {}));
    const values: Record<string, unknown> = { list_sites: {}, list_sitemaps: { siteUrl: "sc-domain:example.com" }, inspect_url: { siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/" }, compare_periods: { siteUrl: "sc-domain:example.com" }, search_analytics: { siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-28" } };
    for (const selected of tools()) {
      expect(selected.annotations).toEqual({ readOnlyHint: true });
      expect(selected.outputSchema).toBeDefined();
      expect(selected.outputSchema?.safeParse(await selected.execute(values[selected.name])).success).toBe(true);
    }
  });
  it("returns a short analytics page without a continuation hint", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "EDITOR@example.com" });
      expect(JSON.parse(String(init.body))).toEqual({ startDate: "2026-09-01", endDate: "2026-09-28", dimensions: [], type: "web", aggregationType: "auto", dataState: "final", rowLimit: 1000, startRow: 0 });
      return json({});
    });
    expect(await tool("search_analytics").execute({ siteUrl: "https://example.com/", startDate: "2026-09-01", endDate: "2026-09-28" })).toEqual({ rows: [], truncated: false, nextStartRow: null, firstIncompleteDate: null, account: "EDITOR@example.com" });
  });
  it("throws Google's ordinary request error and allows a following read", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({ error: { message: "Invalid inspection URL" } }, 400)).mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(tool("inspect_url").execute({ siteUrl: "sc-domain:example.com", inspectionUrl: "https://other.example/" })).rejects.toThrow("Invalid inspection URL");
    expect(await tool("list_sites").execute({})).toMatchObject({ sites: [] });
  });
  it("compares page totals separately from one grouped top-query series", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query");
      const body = JSON.parse(String(init.body)); requests.push(body);
      const rows = body.dimensions.length === 2
        ? [{ keys: ["https://example.com/blog/post/", "portal"], clicks: 2, impressions: 10, ctr: 0.2, position: 5 }]
        : [{ keys: ["https://example.com/blog/post"], clicks: body.startDate === "2026-09-01" ? 10 : 20, impressions: 100, ctr: body.startDate === "2026-09-01" ? 0.1 : 0.2, position: 4 }];
      return json({ rows });
    });
    const result = await tool("compare_periods").execute({ siteUrl: "https://example.com/", current: { startDate: "2026-09-01", endDate: "2026-09-28" }, topQueries: 1, filters: [{ dimension: "country", operator: "equals", expression: "usa" }] });
    expect(result).toMatchObject({ account: "editor@example.com", rows: [{ page: "https://example.com/blog/post", folder: "blog", current: { clicks: 10, impressions: 100 }, previous: { clicks: 20 }, clicksDelta: -10, topQueries: [{ query: "portal", clicks: 2, impressions: 10, position: 5 }] }], meta: { previous: { startDate: "2026-08-04", endDate: "2026-08-31" }, rowsFetched: { current: 1, previous: 1 } } });
    expect(requests).toHaveLength(3);
    expect(requests).toEqual([
      expect.objectContaining({ dimensions: ["page"], type: "web", dataState: "final", rowLimit: 25000, startRow: 0, dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "usa" }] }] }),
      expect.objectContaining({ dimensions: ["page"] }),
      expect.objectContaining({ dimensions: ["page", "query"], dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "usa" }] }] }),
    ]);
  });
  it("times out a hanging HTTP call and allows the next call to progress", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(json({ email: "editor@example.com" })).mockResolvedValueOnce(json({ siteEntry: [] }));
    vi.stubGlobal("fetch", fetcher);
    const selected = tool("list_sites");
    const pending = expect(selected.execute({})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(await selected.execute({})).toEqual({ sites: [], account: "editor@example.com" });
  });
  it.each([
    "User does not have sufficient permission for this site.",
    "Google Search Console API has not been used in project 123 before or it is disabled.",
  ])("throws property/setup guidance for non-scope 403: %s", async message => {
    vi.stubGlobal("fetch", async (input: string) => input.endsWith("/userinfo") ? json({ email: "editor@example.com" }) : json({ error: { message } }, 403));
    await expect(tool("list_sitemaps").execute({ siteUrl: "sc-domain:example.com" })).rejects.toThrow(/sc-domain:example.com/);
  });
  it.each([
    [401, "Invalid Credentials", "expired"],
    [429, "Too many requests", "rate_limited"],
    [403, "Quota exceeded", "rate_limited"],
    [403, "Request had insufficient authentication scopes.", "insufficient_scope"],
  ])("returns an actionable refusal for HTTP %s: %s", async (status, message, reason) => {
    vi.stubGlobal("fetch", async (input: string) => input.endsWith("/userinfo") ? json({ email: "editor@example.com" }) : json({ error: { message } }, status));
    expect(await tool("list_sites").execute({})).toMatchObject({ isError: true, connected: false, provider: "google", reason, message: expect.any(String) });
  });
  it("refuses the wrong connected account before reading property data", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      expect(input).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
      return json({ email: "other@example.com" });
    });
    expect(await tool("list_sites").execute({}, { agentId: "content agent" })).toMatchObject({ isError: true, connected: false, provider: "google", reason: "wrong_account", authorizeUrl: "/agents/content%20agent/extensions/googleSearchConsole" });
  });
  it("lists sitemap health and dates using a verbatim URL-prefix property", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps?sitemapIndex=https%3A%2F%2Fexample.com%2Findex.xml");
      return json({ sitemap: [{ path: "https://example.com/sitemap.xml", type: "sitemap", lastSubmitted: "2026-09-01T00:00:00Z", lastDownloaded: "2026-09-27T00:00:00Z", isPending: false, errors: "2", warnings: "3" }] });
    });
    expect(await tool("list_sitemaps").execute({ siteUrl: "https://example.com/", sitemapIndex: "https://example.com/index.xml" })).toEqual({ account: "editor@example.com", sitemaps: [{ path: "https://example.com/sitemap.xml", type: "sitemap", lastSubmitted: "2026-09-01T00:00:00Z", lastDownloaded: "2026-09-27T00:00:00Z", isPending: false, errors: 2, warnings: 3 }] });
  });
  it("inspects a URL on the v1 endpoint and maps indexing evidence", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/blog/post", languageCode: "en-US" });
      return json({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", lastCrawlTime: "2026-09-27T12:00:00Z", pageFetchState: "SUCCESSFUL", googleCanonical: "https://example.com/blog/post", userCanonical: "https://example.com/blog/post", crawledAs: "MOBILE", sitemap: ["https://example.com/sitemap.xml"] } } });
    });
    expect(await tool("inspect_url").execute({ siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/blog/post", languageCode: "en-US" })).toEqual({ account: "editor@example.com", verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", lastCrawlTime: "2026-09-27T12:00:00Z", pageFetchState: "SUCCESSFUL", googleCanonical: "https://example.com/blog/post", userCanonical: "https://example.com/blog/post", crawledAs: "MOBILE", sitemaps: ["https://example.com/sitemap.xml"] });
  });
  it("queries analytics with AND filters and returns pagination and incomplete-date hints", async () => {
    const row = { keys: ["usa"], clicks: 3, impressions: 30, ctr: 0.1, position: 4 };
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ startDate: "2026-09-01", endDate: "2026-09-28", dimensions: ["country"], dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "usa" }] }], type: "image", aggregationType: "byPage", dataState: "all", rowLimit: 1, startRow: 2 });
      return json({ rows: [row], metadata: { first_incomplete_date: "2026-09-28" } });
    });
    expect(await tool("search_analytics").execute({ siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-28", dimensions: ["country"], filters: [{ dimension: "country", operator: "equals", expression: "usa" }], type: "image", aggregationType: "byPage", dataState: "all", rowLimit: 1, startRow: 2 })).toEqual({ rows: [row], truncated: true, nextStartRow: 3, firstIncompleteDate: "2026-09-28", account: "editor@example.com" });
  });
  it("lists properties and permissions with the verified account", async () => {
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
      if (input.endsWith("/userinfo")) return json({ email: "editor@example.com" });
      expect(input).toBe("https://www.googleapis.com/webmasters/v3/sites");
      return json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
    });
    expect(await tool("list_sites").execute({})).toEqual({ account: "editor@example.com", sites: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
  });
});
