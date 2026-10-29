import type { z } from "zod";
import { googleFailureReason } from "../google-oauth-provider.js";
import { toolSchemas } from "./models.js";
import type { AnalyticsQuery } from "./comparison.js";
const BASE = "https://www.googleapis.com/webmasters/v3";

export class SearchConsoleRequestError extends Error {
  constructor(readonly status: number, readonly reason: string, detail: string) {
    super(`Google Search Console request failed (${reason}, HTTP ${status}): ${detail}`);
  }
}
export class SearchConsoleClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async account(): Promise<string> {
    const data = await this.request("https://www.googleapis.com/oauth2/v2/userinfo");
    return String(data.email ?? "");
  }
  async listSites() {
    const data = await this.request(`${BASE}/sites`);
    return { sites: data.siteEntry ?? [] };
  }
  async listSitemaps(params: z.infer<typeof toolSchemas.list_sitemaps>) {
    const query = params.sitemapIndex === undefined ? "" : `?${new URLSearchParams({ sitemapIndex: params.sitemapIndex })}`;
    const data = await this.request(`${BASE}/sites/${encodeURIComponent(params.siteUrl)}/sitemaps${query}`, {}, params.siteUrl);
    const sitemaps = data.sitemap as Array<Record<string, unknown>> | undefined;
    return { sitemaps: (sitemaps ?? []).map(item => ({ path: item.path, type: item.type ?? null, lastSubmitted: item.lastSubmitted ?? null, lastDownloaded: item.lastDownloaded ?? null, isPending: item.isPending ?? false, errors: Number(item.errors ?? 0), warnings: Number(item.warnings ?? 0) })) };
  }
  async inspectUrl(params: z.infer<typeof toolSchemas.inspect_url>) {
    const data = await this.request("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { method: "POST", body: JSON.stringify(params) }, params.siteUrl);
    const result = (data.inspectionResult as { indexStatusResult?: Record<string, unknown> } | undefined)?.indexStatusResult ?? {};
    return { verdict: result.verdict ?? null, coverageState: result.coverageState ?? null, robotsTxtState: result.robotsTxtState ?? null, indexingState: result.indexingState ?? null, lastCrawlTime: result.lastCrawlTime ?? null, pageFetchState: result.pageFetchState ?? null, googleCanonical: result.googleCanonical ?? null, userCanonical: result.userCanonical ?? null, crawledAs: result.crawledAs ?? null, sitemaps: result.sitemap ?? [] };
  }
  async searchAnalytics(params: AnalyticsQuery & { aggregationType?: "auto" | "byPage" | "byProperty" }) {
    const { siteUrl, filters, ...body } = params;
    const data = await this.request(`${BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: "POST", body: JSON.stringify({ ...body, ...(filters?.length ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}) }) }, siteUrl);
    const rawRows = (data.rows ?? []) as Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
    const rows = rawRows.map(row => ({ ...row, keys: row.keys ?? [] }));
    const metadata = data.metadata as { first_incomplete_date?: string } | undefined;
    return { rows, firstIncompleteDate: metadata?.first_incomplete_date ?? null };
  }
  private async request(url: string, init: RequestInit = {}, siteUrl?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Google Search Console request timed out; retry later")); }, 15000); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
        if (!response.ok) {
          const text = await response.text();
          let detail = text;
          try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* Preserve a non-JSON Google error. */ }
          let reason = googleFailureReason(response.status, text, /rate.?limit|quota|daily.?limit|resource_exhausted/i) ?? "request_failed";
          if (reason === "insufficient_scope" && !/insufficient[_ ]scope|access_token_scope_insufficient|insufficient authentication scopes|missing.*scope/i.test(text)) reason = "request_failed";
          if (response.status === 403 && reason === "request_failed") detail += ` Check that the connected account is a user on property ${siteUrl ?? "selected in Search Console"} and enable Google Search Console API in the OAuth client's Google Cloud project.`;
          throw new SearchConsoleRequestError(response.status, reason, detail);
        }
        return await response.json() as Record<string, unknown>;
      })()]);
    } finally { clearTimeout(timer); }
  }
}
