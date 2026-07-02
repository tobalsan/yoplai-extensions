import {
  PipedriveAuthError,
  PipedriveConnectionError,
  PipedriveError,
  PipedriveNotFoundError,
  PipedriveRateLimitError,
  PipedriveServerError,
  PipedriveValidationError,
} from "./errors.js";
import {
  type DealSummary,
  type ListDealsParams,
  type ListDealsResult,
  type PipedriveConfig,
} from "./models.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

/** Number of internal pages fetched per list_deals call when a close-date range narrows results. */
const MAX_INTERNAL_PAGES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface PipedriveClientOptions extends PipedriveConfig {
  timeoutMs?: number;
}

interface RawDeal {
  id: number;
  title?: string;
  value?: unknown;
  currency?: unknown;
  status?: unknown;
  stage_id?: unknown;
  pipeline_id?: unknown;
  person_id?: unknown;
  org_id?: unknown;
  owner_id?: unknown;
  user_id?: unknown;
  expected_close_date?: unknown;
  [key: string]: unknown;
}

interface DealsPage {
  data: RawDeal[];
  nextCursor: string | null;
}

export class PipedriveClient {
  readonly apiToken: string;
  readonly domain: string;
  readonly baseUrlV1: string;
  readonly baseUrlV2: string;
  private readonly timeoutMs: number;

  constructor(options: PipedriveClientOptions) {
    this.apiToken = options.apiToken;
    this.domain = options.domain;
    this.baseUrlV1 = `https://${this.domain}.pipedrive.com/api/v1`;
    this.baseUrlV2 = `https://${this.domain}.pipedrive.com/api/v2`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * List deals with server-side filters (pipeline/stage/status/person/org/user)
   * plus the net-new expected-close-date range filter applied during cursor
   * pagination assembly. Returns a lean per-deal projection and a next_cursor
   * that resumes exactly where this page stopped (no gaps or dupes).
   */
  async listDeals(params: ListDealsParams): Promise<ListDealsResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const from = params.expected_close_from ?? null;
    const to = params.expected_close_to ?? null;
    const hasRange = from !== null || to !== null;

    const query: Record<string, string | number> = {
      limit,
      status: params.status ?? "open",
      sort_by: params.sort_by ?? "update_time",
      sort_direction: params.sort_direction ?? "desc",
    };
    if (params.pipeline_id !== undefined) query.pipeline_id = params.pipeline_id;
    if (params.stage_id !== undefined) query.stage_id = params.stage_id;
    if (params.person_id !== undefined) query.person_id = params.person_id;
    if (params.org_id !== undefined) query.org_id = params.org_id;
    if (params.user_id !== undefined) query.user_id = params.user_id;

    const matches: DealSummary[] = [];
    let cursor = params.cursor ?? null;
    let pagesFetched = 0;

    // Without a close-date range this loop runs once and returns Pipedrive's
    // native page + cursor unchanged. With a range it keeps fetching pages
    // until `limit` matches are collected (or the pipeline is exhausted),
    // returning the cursor at the stopping point so the next call resumes cleanly.
    do {
      const pageQuery = { ...query };
      if (cursor !== null) pageQuery.cursor = cursor;

      const page = await this.fetchDealsPage(pageQuery);
      pagesFetched += 1;

      for (const raw of page.data) {
        if (hasRange && !inCloseDateRange(raw.expected_close_date, from, to)) {
          continue;
        }
        matches.push(this.toDealSummary(raw));
      }

      cursor = page.nextCursor;

      if (!hasRange) break;
      // Stop once we have at least `limit` in-range matches. We break at a
      // native page boundary (never mid-page), so the returned cursor resumes
      // cleanly with no gaps or dupes. A single page may push the count
      // slightly over `limit`; we keep those deals rather than drop them
      // (dropping would lose deals the advanced cursor has already skipped).
      if (matches.length >= limit) break;
      if (cursor === null) break;
    } while (pagesFetched < MAX_INTERNAL_PAGES);

    return {
      deals: matches,
      next_cursor: cursor,
      count: matches.length,
    };
  }

  private async fetchDealsPage(query: Record<string, string | number>): Promise<DealsPage> {
    const data = await this.requestJson("GET", "v2", "deals", query);
    const rows = Array.isArray(data.data) ? (data.data as RawDeal[]) : [];
    const additional = data.additional_data as Record<string, unknown> | undefined;
    const nextCursor = toStringOrNull(additional?.next_cursor);
    return { data: rows, nextCursor };
  }

  private toDealSummary(raw: RawDeal): DealSummary {
    return {
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title : "",
      value: toNumberOrNull(raw.value),
      currency: toStringOrNull(raw.currency),
      status: toStringOrNull(raw.status),
      stage_id: toNumberOrNull(raw.stage_id),
      pipeline_id: toNumberOrNull(raw.pipeline_id),
      person_id: toNumberOrNull(raw.person_id),
      org_id: toNumberOrNull(raw.org_id),
      user_id: toNumberOrNull(raw.owner_id ?? raw.user_id),
      expected_close_date: toStringOrNull(raw.expected_close_date),
      deal_url: `https://${this.domain}.pipedrive.com/deal/${raw.id}`,
    };
  }

  private buildUrl(
    version: "v1" | "v2",
    endpoint: string,
    query: Record<string, string | number>,
  ): string {
    const base = version === "v2" ? this.baseUrlV2 : this.baseUrlV1;
    const url = new URL(`${base}/${endpoint}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api_token", this.apiToken);
    return url.toString();
  }

  private async requestJson(
    method: string,
    version: "v1" | "v2",
    endpoint: string,
    query: Record<string, string | number> = {},
  ): Promise<Record<string, unknown>> {
    const url = this.buildUrl(version, endpoint, query);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", {
            endpoint,
            status: 429,
          });
        }

        if (response.status >= 500) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new PipedriveServerError(`Pipedrive server error with status ${response.status}`, {
            endpoint,
            status: response.status,
          });
        }

        if (!response.ok) {
          const message = await this.readErrorMessage(response);
          const options = { endpoint, status: response.status };
          if (response.status === 401 || response.status === 403) {
            throw new PipedriveAuthError(message, options);
          }
          if (response.status === 404) {
            throw new PipedriveNotFoundError(message, options);
          }
          if (response.status === 400 || response.status === 409 || response.status === 422) {
            throw new PipedriveValidationError(message, options);
          }
          throw new PipedriveError(message, options);
        }

        const text = await response.text();
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (error) {
        if (error instanceof PipedriveError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new PipedriveConnectionError(error.message, { endpoint });
        }
        throw error;
      }
    }

    throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", { endpoint, status: 429 });
  }

  /** Backoff delay honoring Retry-After (seconds or HTTP-date) when present. */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
    return Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
  }

  private async readErrorMessage(response: Response): Promise<string> {
    const fallback = response.statusText || `Pipedrive request failed with status ${response.status}`;
    const text = await response.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed.error ?? parsed.message;
      return typeof message === "string" && message.length > 0 ? message : fallback;
    } catch {
      return fallback;
    }
  }
}

/**
 * Inclusive expected-close-date range check. Deals without an expected close
 * date are excluded when any bound is set (they cannot satisfy a date range).
 */
export function inCloseDateRange(
  value: unknown,
  from: string | null,
  to: string | null,
): boolean {
  const date = toStringOrNull(value);
  if (date === null) return false;
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}
