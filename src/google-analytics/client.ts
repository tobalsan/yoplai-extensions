import { googleFailureReason } from "../google-oauth-provider.js";
import type { ReportRequest, ReportResponse } from "./comparison.js";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

export class GoogleAnalyticsRequestError extends Error {
  constructor(readonly status: number, readonly reason: string, detail: string) {
    super(`Google Analytics request failed (${reason}, HTTP ${status}): ${detail}`);
  }
}
interface AccountSummary { account: string; displayName: string; propertySummaries?: { property: string; displayName: string }[] }
interface KeyEvent { eventName: string; countingMethod?: string; custom?: boolean }
interface MetadataField { apiName: string; uiName: string; description?: string; scope?: string; customDefinition?: boolean }
export class GoogleAnalyticsClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async account(): Promise<string> {
    const data = await this.request("https://www.googleapis.com/oauth2/v2/userinfo");
    return String(data.email ?? "");
  }
  async accountSummaries() {
    const summaries: AccountSummary[] = [];
    let nextPageToken: string | undefined;
    do {
      const query = nextPageToken ? `?${new URLSearchParams({ pageToken: nextPageToken })}` : "";
      const data = await this.request(`${ADMIN}/accountSummaries${query}`);
      summaries.push(...(data.accountSummaries ?? []) as AccountSummary[]);
      nextPageToken = data.nextPageToken as string | undefined;
    } while (nextPageToken);
    return summaries;
  }
  async getProperty(property: string) {
    const data = await this.request(`${ADMIN}/${property}`, {}, property);
    return { displayName: String(data.displayName ?? ""), timeZone: String(data.timeZone ?? "UTC"), currencyCode: String(data.currencyCode ?? "") };
  }
  async listKeyEvents(property: string) {
    const events: KeyEvent[] = [];
    let nextPageToken: string | undefined;
    do {
      const query = nextPageToken ? `?${new URLSearchParams({ pageToken: nextPageToken })}` : "";
      const data = await this.request(`${ADMIN}/${property}/keyEvents${query}`, {}, property);
      events.push(...(data.keyEvents ?? []) as KeyEvent[]);
      nextPageToken = data.nextPageToken as string | undefined;
    } while (nextPageToken);
    return events.map(event => ({ eventName: event.eventName, countingMethod: event.countingMethod ?? null, custom: event.custom ?? false }));
  }
  async getMetadata(property: string) {
    const data = await this.request(`https://analyticsdata.googleapis.com/v1beta/${property}/metadata`, {}, property);
    const fields = (value: unknown) => ((value ?? []) as MetadataField[]).filter(field => field.customDefinition === true).map(field => ({ apiName: field.apiName, uiName: field.uiName, description: field.description ?? null, scope: field.scope ?? null }));
    return { customDimensions: fields(data.dimensions), customMetrics: fields(data.metrics) };
  }
  async runReport(property: string, body: ReportRequest): Promise<ReportResponse> {
    return await this.request(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, { method: "POST", body: JSON.stringify(body) }, property) as ReportResponse;
  }
  private async request(url: string, init: RequestInit = {}, property?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Google Analytics request timed out; retry later")); }, 30000); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
        if (!response.ok) {
          const text = await response.text();
          let detail = text;
          try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* Preserve a non-JSON Google error. */ }
          let reason = googleFailureReason(response.status, text, /rate.?limit|quota|daily.?limit|resource_exhausted/i) ?? "request_failed";
          if (reason === "insufficient_scope" && !/insufficient[_ ]scope|access_token_scope_insufficient|insufficient authentication scopes|missing.*scope/i.test(text)) reason = "request_failed";
          if (response.status === 403 && reason === "request_failed") detail += ` Check that the connected account has at least Viewer on GA4 property ${property ?? "selected in Google Analytics"} and enable both the Analytics Data API and Analytics Admin API in the OAuth client's Google Cloud project.`;
          throw new GoogleAnalyticsRequestError(response.status, reason, detail);
        }
        return await response.json() as Record<string, unknown>;
      })()]);
    } finally { clearTimeout(timer); }
  }
}
