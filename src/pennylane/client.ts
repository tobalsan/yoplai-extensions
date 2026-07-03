import {
  CreateInvoiceDraftParamsSchema,
  CreateQuoteParamsSchema,
  CustomerInvoiceSchema,
  CustomerSchema,
  GetCustomerParamsSchema,
  GetInvoiceParamsSchema,
  GetProductParamsSchema,
  GetQuoteParamsSchema,
  ListInvoicesParamsSchema,
  ListParamsSchema,
  ListVatRatesParamsSchema,
  ProductSchema,
  QuoteSchema,
  SearchCustomersParamsSchema,
  SearchInvoicesParamsSchema,
  SearchProductsParamsSchema,
  SearchQuotesParamsSchema,
  UpdateInvoiceDraftParamsSchema,
  UpdateQuoteParamsSchema,
  VAT_RATES,
  VatRateReferenceSchema,
  type Customer,
  type CustomerInvoice,
  type Product,
  type Quote,
  type VatRateReference,
} from "./models.js";
import type { ZodType, output } from "zod";
import { FilterBuilder, type FilterClause } from "./filter-builder.js";
import { DraftGuard } from "./draft-guard.js";
import {
  PennylaneAuthError,
  PennylaneConnectionError,
  PennylaneError,
  PennylaneGuardRefusedError,
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

  /** Pure gate: only `draft: true` invoices / `pending` quotes may be mutated. */
  private readonly draftGuard = new DraftGuard();

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

  /** Connectivity/auth probe for the extension validate tool. */
  async validate(): Promise<{ ok: true; account: JsonValue }> {
    return { ok: true, account: await this.verifyToken() };
  }

  /**
   * List customer invoices, walking the cursor transparently. When `cursor` is
   * omitted, every page is fetched and concatenated so callers get the full
   * list without managing pagination. When `cursor` is provided, a single page
   * starting from it is returned.
   */
  async listInvoices(input: unknown = {}): Promise<{ invoices: CustomerInvoice[] }> {
    const params = ListInvoicesParamsSchema.parse(input);
    return this.fetchInvoices({ cursor: params.cursor, limit: params.limit });
  }

  /**
   * Search customer invoices by customer, `external_reference`, status, and
   * date. Each provided filter is translated into a Pennylane filter clause via
   * `FilterBuilder` and AND-combined into a single `filter` param. Results are
   * cursor-walked exactly like `listInvoices` (the `filter` is re-sent on every
   * page, as the cursor encodes position only — not the filter/sort).
   */
  async searchInvoices(input: unknown = {}): Promise<{ invoices: CustomerInvoice[] }> {
    const params = SearchInvoicesParamsSchema.parse(input);

    const clauses: FilterClause[] = [];
    if (params.customerId !== undefined) {
      clauses.push({ field: "customer_id", operator: "eq", value: params.customerId });
    }
    if (params.externalReference !== undefined) {
      clauses.push({
        field: "external_reference",
        operator: "eq",
        value: params.externalReference,
      });
    }
    if (params.status !== undefined) {
      clauses.push(
        Array.isArray(params.status)
          ? { field: "status", operator: "in", value: params.status }
          : { field: "status", operator: "eq", value: params.status },
      );
    }
    if (params.dateFrom !== undefined) {
      clauses.push({ field: "date", operator: "gteq", value: params.dateFrom });
    }
    if (params.dateTo !== undefined) {
      clauses.push({ field: "date", operator: "lteq", value: params.dateTo });
    }

    const filter = FilterBuilder.from(clauses).toJSON();

    return this.fetchInvoices({
      cursor: params.cursor,
      limit: params.limit,
      filter: clauses.length > 0 ? filter : undefined,
    });
  }

  /**
   * Shared invoice fetch + cursor walk. When `cursor` is provided a single page
   * is returned; otherwise every page is fetched and concatenated. The `filter`
   * (already a JSON array string) is passed through on every request.
   */
  private async fetchInvoices(input: {
    cursor?: string;
    limit: number;
    filter?: string;
  }): Promise<{ invoices: CustomerInvoice[] }> {
    const invoices = await this.fetchList("customer_invoices", CustomerInvoiceSchema, input);
    return { invoices };
  }

  /**
   * Generic list fetch + cursor walk for any v2 collection endpoint. When
   * `cursor` is provided a single page is returned; otherwise every page is
   * fetched and concatenated. The `filter` (a JSON array string) is re-sent on
   * every request, as the cursor encodes position only (§1.3). Each item is
   * validated against `schema`.
   */
  private async fetchList<S extends ZodType>(
    path: string,
    schema: S,
    input: { cursor?: string; limit: number; filter?: string },
  ): Promise<output<S>[]> {
    const results: output<S>[] = [];
    let cursor = input.cursor;
    const singlePage = input.cursor !== undefined;

    for (;;) {
      const page = (await this.request("GET", path, {
        cursor,
        limit: input.limit,
        filter: input.filter,
      })) as CursorPage;

      for (const item of page.items ?? []) {
        results.push(schema.parse(item));
      }

      if (singlePage || !page.hasMore || !page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    return results;
  }

  /** Get a single customer invoice by its int64 id. */
  async getInvoice(input: unknown): Promise<{ invoice: CustomerInvoice }> {
    const params = GetInvoiceParamsSchema.parse(input);
    const raw = await this.request("GET", `customer_invoices/${params.id}`);
    return { invoice: CustomerInvoiceSchema.parse(raw) };
  }

  /**
   * Create a customer invoice as an editable **draft** (§2.3). Always sends
   * `draft: true` — this tool cannot finalize. `externalReference` (the
   * Pipedrive deal id) is passed through for correlation/dedup; since Pennylane
   * has no idempotency keys, callers dedupe by looking it up first (§4.5).
   */
  async createInvoiceDraft(input: unknown): Promise<{ invoice: CustomerInvoice }> {
    const params = CreateInvoiceDraftParamsSchema.parse(input);
    const body = { ...compact(params), draft: true };
    const raw = await this.request("POST", "customer_invoices", undefined, body);
    return { invoice: CustomerInvoiceSchema.parse(raw) };
  }

  /**
   * Update an existing invoice **draft** (§2.4, `PUT` full-replace). Before any
   * write, the target is re-read and routed through `DraftGuard`: a finalized
   * invoice is refused with `PennylaneGuardRefusedError` and the write never
   * reaches Pennylane. `draft` stays `true` — this tool cannot finalize.
   */
  async updateInvoiceDraft(input: unknown): Promise<{ invoice: CustomerInvoice }> {
    const params = UpdateInvoiceDraftParamsSchema.parse(input);
    const { id, ...updates } = params;

    const current = await this.request("GET", `customer_invoices/${id}`);
    const target = CustomerInvoiceSchema.parse(current);

    const decision = this.draftGuard.evaluate({ draft: target.draft });
    if (!decision.allowed) {
      throw new PennylaneGuardRefusedError(
        `Refusing to update customer invoice ${id}: ${decision.reason}`,
        { endpoint: `customer_invoices/${id}` },
      );
    }

    const body = { ...compact(updates), draft: true };
    const raw = await this.request("PUT", `customer_invoices/${id}`, undefined, body);
    return { invoice: CustomerInvoiceSchema.parse(raw) };
  }

  /**
   * List quotes, walking the cursor transparently (omit `cursor` for all quotes,
   * pass one for a single page).
   */
  async listQuotes(input: unknown = {}): Promise<{ quotes: Quote[] }> {
    const params = ListParamsSchema.parse(input);
    const quotes = await this.fetchList("quotes", QuoteSchema, {
      cursor: params.cursor,
      limit: params.limit,
    });
    return { quotes };
  }

  /**
   * Search quotes. Only `customer_id` and `status` are server-side filterable
   * (§3.1); `external_reference` is NOT, so when provided it is matched
   * client-side on the returned quotes after filtering by `customer_id` (§4.5).
   * No local id-map is kept.
   */
  async searchQuotes(input: unknown = {}): Promise<{ quotes: Quote[] }> {
    const params = SearchQuotesParamsSchema.parse(input);

    const clauses: FilterClause[] = [];
    if (params.customerId !== undefined) {
      clauses.push({ field: "customer_id", operator: "eq", value: params.customerId });
    }
    if (params.status !== undefined) {
      clauses.push(
        Array.isArray(params.status)
          ? { field: "status", operator: "in", value: params.status }
          : { field: "status", operator: "eq", value: params.status },
      );
    }

    const filter = FilterBuilder.from(clauses).toJSON();
    let quotes = await this.fetchList("quotes", QuoteSchema, {
      cursor: params.cursor,
      limit: params.limit,
      filter: clauses.length > 0 ? filter : undefined,
    });

    if (params.externalReference !== undefined) {
      quotes = quotes.filter((quote) => quote.externalReference === params.externalReference);
    }

    return { quotes };
  }

  /** Get a single quote by its int64 id. */
  async getQuote(input: unknown): Promise<{ quote: Quote }> {
    const params = GetQuoteParamsSchema.parse(input);
    const raw = await this.request("GET", `quotes/${params.id}`);
    return { quote: QuoteSchema.parse(raw) };
  }

  /**
   * Create a quote (§3.3). Pennylane quotes have no draft/status field on create
   * — the created quote is always `pending`, which the write path treats as the
   * draft-equivalent. `externalReference` (the Pipedrive deal id) is passed
   * through for correlation/dedup; since quotes are not server-side filterable on
   * it, callers dedupe by looking it up client-side first (§4.5). This tool
   * cannot accept or send a quote — there is deliberately no such tool.
   */
  async createQuote(input: unknown): Promise<{ quote: Quote }> {
    const params = CreateQuoteParamsSchema.parse(input);
    const body = compact(params);
    const raw = await this.request("POST", "quotes", undefined, body);
    return { quote: QuoteSchema.parse(raw) };
  }

  /**
   * Update a quote (§3.4, `PUT /quotes/{id}`). Before any write, the target is
   * re-read and routed through `DraftGuard`: a non-`pending` quote
   * (accepted/denied/invoiced/expired/sent) is refused with
   * `PennylaneGuardRefusedError` and the write never reaches Pennylane. Status is
   * not editable here, and `invoiceLines` uses the `{ create, update, delete }`
   * diff object rather than a flat array.
   */
  async updateQuote(input: unknown): Promise<{ quote: Quote }> {
    const params = UpdateQuoteParamsSchema.parse(input);
    const { id, ...updates } = params;

    const current = await this.request("GET", `quotes/${id}`);
    const target = QuoteSchema.parse(current);

    const decision = this.draftGuard.evaluate({ status: target.status });
    if (!decision.allowed) {
      throw new PennylaneGuardRefusedError(
        `Refusing to update quote ${id}: ${decision.reason}`,
        { endpoint: `quotes/${id}` },
      );
    }

    const body = compact(updates);
    const raw = await this.request("PUT", `quotes/${id}`, undefined, body);
    return { quote: QuoteSchema.parse(raw) };
  }

  /**
   * List customers (unified endpoint covering both company and individual),
   * walking the cursor transparently.
   */
  async listCustomers(input: unknown = {}): Promise<{ customers: Customer[] }> {
    const params = ListParamsSchema.parse(input);
    const customers = await this.fetchList("customers", CustomerSchema, {
      cursor: params.cursor,
      limit: params.limit,
    });
    return { customers };
  }

  /**
   * Search customers by `external_reference`, `name`, and `customer_type` — all
   * server-side filterable (§4.1), AND-combined via `FilterBuilder`.
   */
  async searchCustomers(input: unknown = {}): Promise<{ customers: Customer[] }> {
    const params = SearchCustomersParamsSchema.parse(input);

    const clauses: FilterClause[] = [];
    if (params.externalReference !== undefined) {
      clauses.push({ field: "external_reference", operator: "eq", value: params.externalReference });
    }
    if (params.name !== undefined) {
      clauses.push({ field: "name", operator: "eq", value: params.name });
    }
    if (params.customerType !== undefined) {
      clauses.push({ field: "customer_type", operator: "eq", value: params.customerType });
    }

    const filter = FilterBuilder.from(clauses).toJSON();
    const customers = await this.fetchList("customers", CustomerSchema, {
      cursor: params.cursor,
      limit: params.limit,
      filter: clauses.length > 0 ? filter : undefined,
    });
    return { customers };
  }

  /**
   * Get a single customer by internal `id` or by `external_reference` (the
   * Pipedrive org/person id hook). When `externalReference` is given, resolve it
   * via an `eq` filter and return the first match (or throw if none). Exactly one
   * of `id`/`externalReference` is required (enforced by the schema).
   */
  async getCustomer(input: unknown): Promise<{ customer: Customer }> {
    const params = GetCustomerParamsSchema.parse(input);

    if ((params.id !== undefined) === (params.externalReference !== undefined)) {
      throw new PennylaneValidationError("provide exactly one of `id` or `externalReference`", {
        endpoint: "customers",
        status: 400,
      });
    }

    if (params.id !== undefined) {
      const raw = await this.request("GET", `customers/${params.id}`);
      return { customer: CustomerSchema.parse(raw) };
    }

    const filter = FilterBuilder.from([
      { field: "external_reference", operator: "eq", value: params.externalReference! },
    ]).toJSON();
    const customers = await this.fetchList("customers", CustomerSchema, {
      cursor: undefined,
      limit: 1,
      filter,
    });
    const customer = customers[0];
    if (!customer) {
      throw new PennylaneNotFoundError(
        `No customer with external_reference "${params.externalReference}"`,
        { endpoint: "customers", status: 404 },
      );
    }
    return { customer };
  }

  /** List products, walking the cursor transparently. */
  async listProducts(input: unknown = {}): Promise<{ products: Product[] }> {
    const params = ListParamsSchema.parse(input);
    const products = await this.fetchList("products", ProductSchema, {
      cursor: params.cursor,
      limit: params.limit,
    });
    return { products };
  }

  /**
   * Search products by `external_reference`, `label`, and `reference` — all
   * server-side filterable (§4.2), AND-combined via `FilterBuilder`.
   */
  async searchProducts(input: unknown = {}): Promise<{ products: Product[] }> {
    const params = SearchProductsParamsSchema.parse(input);

    const clauses: FilterClause[] = [];
    if (params.externalReference !== undefined) {
      clauses.push({ field: "external_reference", operator: "eq", value: params.externalReference });
    }
    if (params.label !== undefined) {
      clauses.push({ field: "label", operator: "eq", value: params.label });
    }
    if (params.reference !== undefined) {
      clauses.push({ field: "reference", operator: "eq", value: params.reference });
    }

    const filter = FilterBuilder.from(clauses).toJSON();
    const products = await this.fetchList("products", ProductSchema, {
      cursor: params.cursor,
      limit: params.limit,
      filter: clauses.length > 0 ? filter : undefined,
    });
    return { products };
  }

  /** Get a single product by its int64 id. */
  async getProduct(input: unknown): Promise<{ product: Product }> {
    const params = GetProductParamsSchema.parse(input);
    const raw = await this.request("GET", `products/${params.id}`);
    return { product: ProductSchema.parse(raw) };
  }

  /**
   * Return the discoverable `vat_rate` reference. Pennylane has no "list VAT
   * rates" endpoint — `vat_rate` is a fixed enum (§4.3), so this is a static
   * reference (no network call) so the agent can pick valid codes like `FR_200`.
   */
  async listVatRates(input: unknown = {}): Promise<{ vatRates: VatRateReference[] }> {
    ListVatRatesParamsSchema.parse(input);
    return { vatRates: VAT_RATES.map((rate) => VatRateReferenceSchema.parse(rate)) };
  }
}
