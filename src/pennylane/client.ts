import {
  CustomerInvoiceSchema,
  ListInvoicesParamsSchema,
  type CustomerInvoice,
} from "./models.js";
import {
  PennylaneAuthError,
  PennylaneConnectionError,
  PennylaneError,
  PennylaneNotFoundError,
  PennylaneRateLimitError,
  PennylaneValidationError,
} from "./errors.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PennylaneClientOptions {
  apiToken: string;
  timeoutMs?: number;
}

/** Base URL for the Pennylane Company API v2. v1 is deprecated. */
const BASE_URL = "https://app.pennylane.com/api/external/v2";

/** Rate limit is 25 requests per 5 seconds per token; we self-throttle to it. */
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 5000;

/** Total attempts per request before giving up (initial try + retries). */
const MAX_ATTEMPTS = 4;

interface CursorPage {
  items?: unknown[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function mapDeep(value: JsonValue, mapper: (key: string) => string): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => mapDeep(item, mapper));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [mapper(key), mapDeep(nested as JsonValue, mapper)]),
    );
  }
  return value;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PennylaneClient wraps the Company API v2: Bearer auth, cursor pagination
 * (walked transparently), proactive rate-limit self-throttling (25 req / 5 s
 * per token), and `429` + `retry-after` backoff. Money is returned as decimal
 * strings, dates as `YYYY-MM-DD`, and int64 ids as strings — all enforced by
 * the Zod schemas in models.ts.
 */
export class PennylaneClient {
  readonly apiToken: string;
  readonly timeoutMs: number;
  readonly baseUrl: string;

  /** Timestamps (ms) of recent requests, used for the sliding-window throttle. */
  private requestTimes: number[] = [];

  constructor({ apiToken, timeoutMs = 30000 }: PennylaneClientOptions) {
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
    this.baseUrl = BASE_URL;
  }

  /**
   * Block until issuing another request stays within 25 req / 5 s. Prunes the
   * sliding window, then sleeps just long enough for the oldest in-window
   * request to age out when the window is full.
   */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (this.requestTimes.length < RATE_LIMIT_MAX) {
        this.requestTimes.push(now);
        return;
      }
      const oldest = this.requestTimes[0] ?? now;
      await sleep(RATE_LIMIT_WINDOW_MS - (now - oldest) + 1);
    }
  }

  private async request(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<JsonValue> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(compact(params ?? {}))) {
      url.searchParams.set(toSnakeCase(key), String(value));
    }

    const payload = body ? JSON.stringify(mapDeep(body as JsonValue, toSnakeCase)) : undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await this.throttle();
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.apiToken}`,
            ...(payload ? { "Content-Type": "application/json" } : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const requestId = response.headers.get("x-request-id") ?? undefined;

        if (response.status === 429) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new PennylaneRateLimitError("Rate limit exceeded", {
            endpoint: path,
            status: 429,
            requestId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          throw new PennylaneAuthError("Authentication failed", {
            endpoint: path,
            status: response.status,
            requestId,
          });
        }

        if (response.status === 404) {
          throw new PennylaneNotFoundError(`Resource not found: ${path}`, {
            endpoint: path,
            status: 404,
            requestId,
          });
        }

        if (response.status === 400 || response.status === 422) {
          throw new PennylaneValidationError((await response.text()) || "Validation failed", {
            endpoint: path,
            status: response.status,
            requestId,
          });
        }

        if (response.status >= 500) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep((attempt + 1) * 250);
            continue;
          }
          throw new PennylaneError(`Server error: ${response.status}`, {
            endpoint: path,
            status: response.status,
            requestId,
          });
        }

        if (!response.ok) {
          throw new PennylaneError(`Request failed: ${response.status}`, {
            endpoint: path,
            status: response.status,
            requestId,
          });
        }

        const text = await response.text();
        return text ? mapDeep(JSON.parse(text) as JsonValue, toCamelCase) : {};
      } catch (error) {
        if (error instanceof PennylaneError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new PennylaneConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new PennylaneRateLimitError("Rate limit exceeded", { endpoint: path, status: 429 });
  }

  /** Backoff delay honoring `retry-after` (seconds) when present. */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
    }
    return (attempt + 1) * 1000;
  }

  /** Verify the API token by calling `GET /me`. Throws on invalid auth. */
  async verifyToken(): Promise<JsonValue> {
    return this.request("GET", "me");
  }

  /**
   * List customer invoices, walking the cursor transparently. When `cursor` is
   * omitted, every page is fetched and concatenated so callers get the full
   * list without managing pagination. When `cursor` is provided, a single page
   * starting from it is returned.
   */
  async listInvoices(input: unknown = {}): Promise<{ invoices: CustomerInvoice[] }> {
    const params = ListInvoicesParamsSchema.parse(input);
    const invoices: CustomerInvoice[] = [];
    let cursor = params.cursor;
    const singlePage = params.cursor !== undefined;

    for (;;) {
      const page = (await this.request("GET", "customer_invoices", {
        cursor,
        limit: params.limit,
      })) as CursorPage;

      for (const item of page.items ?? []) {
        invoices.push(CustomerInvoiceSchema.parse(item));
      }

      if (singlePage || !page.hasMore || !page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    return { invoices };
  }
}
