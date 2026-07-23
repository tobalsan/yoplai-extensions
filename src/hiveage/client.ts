import {
  addEstimateUrl,
  addInvoiceUrl,
  addRecurringInvoiceUrl,
  ConnectionSchema,
  CreateEstimateParamsSchema,
  CreateInvoiceParamsSchema,
  CreatePaymentParamsSchema,
  CreateRecurringInvoiceParamsSchema,
  EstimateSchema,
  GetConnectionParamsSchema,
  GetEstimateParamsSchema,
  GetInvoiceParamsSchema,
  GetItemParamsSchema,
  GetPaymentParamsSchema,
  GetRecurringInvoiceParamsSchema,
  InvoiceSchema,
  ItemDetailSchema,
  ListConnectionsParamsSchema,
  ListEstimatesParamsSchema,
  ListInvoicesParamsSchema,
  ListItemsParamsSchema,
  ListPaymentsParamsSchema,
  ListRecurringInvoicesParamsSchema,
  ListTrashParamsSchema,
  PaymentSchema,
  RecurringInvoiceSchema,
  SearchConnectionsParamsSchema,
  SearchEstimatesParamsSchema,
  SearchInvoicesParamsSchema,
  SearchItemsParamsSchema,
  SearchRecurringInvoicesParamsSchema,
  TrashItemSchema,
  type Connection,
  type Estimate,
  type Invoice,
  type ItemDetail,
  type Payment,
  type RecurringInvoice,
  type TrashItem,
} from "./models.js";
import {
  HiveageAuthError,
  HiveageConnectionError,
  HiveageError,
  HiveageNotFoundError,
  HiveageRateLimitError,
  HiveageValidationError,
} from "./errors.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface HiveageClientOptions {
  apiKey: string;
  subdomain: string;
  timeoutMs?: number;
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

export class HiveageClient {
  readonly apiKey: string;
  readonly subdomain: string;
  readonly timeoutMs: number;
  readonly baseUrl: string;

  constructor({ apiKey, subdomain, timeoutMs = 30000 }: HiveageClientOptions) {
    this.apiKey = apiKey;
    this.subdomain = subdomain;
    this.timeoutMs = timeoutMs;
    this.baseUrl = `https://${subdomain}.hiveage.com/api`;
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
    const auth = `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            Authorization: auth,
            ...(payload ? { "Content-Type": "application/json" } : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const correlationId =
          response.headers.get("x-correlation-id") ?? response.headers.get("x-request-id") ?? undefined;

        if (response.status === 429) {
          if (attempt < 3) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
            continue;
          }
          throw new HiveageRateLimitError("Rate limit exceeded", {
            endpoint: path,
            status: 429,
            correlationId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          const responseBody = await this.readErrorBody(response);
          throw new HiveageAuthError(`Authentication failed for ${path}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        if (response.status === 404) {
          const responseBody = await this.readErrorBody(response);
          throw new HiveageNotFoundError(`Resource not found: ${path}: ${responseBody}`, {
            endpoint: path,
            status: 404,
            correlationId,
            responseBody,
          });
        }

        if (response.status === 400 || response.status === 422) {
          const responseBody = await this.readErrorBody(response);
          throw new HiveageValidationError(`Validation failed for ${path}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        if (response.status >= 500) {
          if (attempt < 3) {
            await sleep((attempt + 1) * 250);
            continue;
          }
          const responseBody = await this.readErrorBody(response);
          throw new HiveageError(`Server error for ${path}: ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        if (!response.ok) {
          const responseBody = await this.readErrorBody(response);
          throw new HiveageError(`Request failed for ${path}: ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        const text = await response.text();
        return text ? mapDeep(JSON.parse(text) as JsonValue, toCamelCase) : {};
      } catch (error) {
        if (error instanceof HiveageError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new HiveageConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new HiveageRateLimitError("Rate limit exceeded", { endpoint: path, status: 429 });
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      const body = await response.text();
      return body.slice(0, 500);
    } catch {
      return "";
    }
  }

  async listInvoices(input: unknown = {}): Promise<{ invoices: Invoice[] }> {
    const params = ListInvoicesParamsSchema.parse(input);
    const data = (await this.request("GET", "invs", params)) as { invoices?: unknown[] };
    return { invoices: (data.invoices ?? []).map((invoice) => addInvoiceUrl(InvoiceSchema.parse(invoice), this.subdomain)) };
  }

  async getInvoice(input: unknown): Promise<{ invoice: Invoice }> {
    const { hashKey } = GetInvoiceParamsSchema.parse(input);
    const data = (await this.request("GET", `invs/${hashKey}`)) as { invoice: unknown };
    return { invoice: addInvoiceUrl(InvoiceSchema.parse(data.invoice), this.subdomain) };
  }

  async createInvoice(input: unknown): Promise<{ invoice: Invoice }> {
    const invoice = CreateInvoiceParamsSchema.parse(input);
    const data = (await this.request("POST", "invs", undefined, { invoice })) as { invoice: unknown };
    return { invoice: addInvoiceUrl(InvoiceSchema.parse(data.invoice), this.subdomain) };
  }

  async searchInvoices(input: unknown): Promise<{ invoices: Invoice[] }> {
    const params = SearchInvoicesParamsSchema.parse(input);
    const data = (await this.request("GET", "invs", {
      q: params.query,
      fields: params.fields,
      order: params.order,
      column: params.column,
    })) as { invoices?: unknown[] };
    return { invoices: (data.invoices ?? []).map((invoice) => addInvoiceUrl(InvoiceSchema.parse(invoice), this.subdomain)) };
  }

  async listRecurringInvoices(input: unknown = {}): Promise<{ recurringInvoices: RecurringInvoice[] }> {
    const params = ListRecurringInvoicesParamsSchema.parse(input);
    const data = (await this.request("GET", "rinv", params)) as { recurringInvoices?: unknown[] };
    return {
      recurringInvoices: (data.recurringInvoices ?? []).map((invoice) =>
        addRecurringInvoiceUrl(RecurringInvoiceSchema.parse(invoice), this.subdomain),
      ),
    };
  }

  async getRecurringInvoice(input: unknown): Promise<{ recurringInvoice: RecurringInvoice }> {
    const { hashKey } = GetRecurringInvoiceParamsSchema.parse(input);
    const data = (await this.request("GET", `rinv/${hashKey}`)) as { recurringInvoice: unknown };
    return {
      recurringInvoice: addRecurringInvoiceUrl(RecurringInvoiceSchema.parse(data.recurringInvoice), this.subdomain),
    };
  }

  async createRecurringInvoice(input: unknown): Promise<{ recurringInvoice: RecurringInvoice }> {
    const recurringInvoice = CreateRecurringInvoiceParamsSchema.parse(input);
    const data = (await this.request("POST", "rinv", undefined, { recurringInvoice })) as {
      recurringInvoice: unknown;
    };
    return {
      recurringInvoice: addRecurringInvoiceUrl(RecurringInvoiceSchema.parse(data.recurringInvoice), this.subdomain),
    };
  }

  async searchRecurringInvoices(input: unknown): Promise<{ recurringInvoices: RecurringInvoice[] }> {
    const params = SearchRecurringInvoicesParamsSchema.parse(input);
    const data = (await this.request("GET", "rinv", {
      q: params.query,
      fields: params.fields,
      order: params.order,
      column: params.column,
    })) as { recurringInvoices?: unknown[] };
    return {
      recurringInvoices: (data.recurringInvoices ?? []).map((invoice) =>
        addRecurringInvoiceUrl(RecurringInvoiceSchema.parse(invoice), this.subdomain),
      ),
    };
  }

  async listEstimates(input: unknown = {}): Promise<{ estimates: Estimate[] }> {
    const params = ListEstimatesParamsSchema.parse(input);
    const data = (await this.request("GET", "estm", params)) as { estimates?: unknown[] };
    return { estimates: (data.estimates ?? []).map((estimate) => addEstimateUrl(EstimateSchema.parse(estimate), this.subdomain)) };
  }

  async getEstimate(input: unknown): Promise<{ estimate: Estimate }> {
    const { hashKey } = GetEstimateParamsSchema.parse(input);
    const data = (await this.request("GET", `estm/${hashKey}`)) as { estimate: unknown };
    return { estimate: addEstimateUrl(EstimateSchema.parse(data.estimate), this.subdomain) };
  }

  async createEstimate(input: unknown): Promise<{ estimate: Estimate }> {
    const estimate = CreateEstimateParamsSchema.parse(input);
    const data = (await this.request("POST", "estm", undefined, { estimate })) as { estimate: unknown };
    return { estimate: addEstimateUrl(EstimateSchema.parse(data.estimate), this.subdomain) };
  }

  async searchEstimates(input: unknown): Promise<{ estimates: Estimate[] }> {
    const params = SearchEstimatesParamsSchema.parse(input);
    const data = (await this.request("GET", "estm", {
      q: params.query,
      fields: params.fields,
      order: params.order,
      column: params.column,
    })) as { estimates?: unknown[] };
    return { estimates: (data.estimates ?? []).map((estimate) => addEstimateUrl(EstimateSchema.parse(estimate), this.subdomain)) };
  }

  async listPayments(input: unknown): Promise<{ payments: Payment[] }> {
    const params = ListPaymentsParamsSchema.parse(input);
    const data = (await this.request("GET", `invs/${params.invoiceHashKey}/payments`, {
      perPage: params.perPage,
      page: params.page,
    })) as { payments?: unknown[] };
    return { payments: (data.payments ?? []).map((payment) => PaymentSchema.parse(payment)) };
  }

  async getPayment(input: unknown): Promise<{ payment: Payment }> {
    const { invoiceHashKey, paymentId } = GetPaymentParamsSchema.parse(input);
    const data = (await this.request("GET", `invs/${invoiceHashKey}/payments/${paymentId}`)) as {
      payment: unknown;
    };
    return { payment: PaymentSchema.parse(data.payment) };
  }

  async createPayment(input: unknown): Promise<{ payment: Payment }> {
    const payment = CreatePaymentParamsSchema.parse(input);
    const { invoiceHashKey, ...paymentPayload } = payment;
    const data = (await this.request("POST", `invs/${invoiceHashKey}/payments`, undefined, {
      payment: paymentPayload,
    })) as { payment: unknown };
    return { payment: PaymentSchema.parse(data.payment) };
  }

  async listItems(input: unknown = {}): Promise<{ itemCategories: ItemDetail[] }> {
    const params = ListItemsParamsSchema.parse(input);
    const data = (await this.request("GET", "categories/items", params)) as { itemCategories?: unknown[] };
    return { itemCategories: (data.itemCategories ?? []).map((item) => ItemDetailSchema.parse(item)) };
  }

  async getItem(input: unknown): Promise<{ itemCategory: ItemDetail }> {
    const { itemId } = GetItemParamsSchema.parse(input);
    const data = (await this.request("GET", `categories/items/${itemId}`)) as { itemCategory: unknown };
    return { itemCategory: ItemDetailSchema.parse(data.itemCategory) };
  }

  async searchItems(input: unknown): Promise<{ itemCategories: ItemDetail[] }> {
    const params = SearchItemsParamsSchema.parse(input);
    const data = (await this.request("GET", "categories/items", {
      q: params.query,
      fields: params.fields,
      order: params.order,
      column: params.column,
    })) as { itemCategories?: unknown[] };
    return { itemCategories: (data.itemCategories ?? []).map((item) => ItemDetailSchema.parse(item)) };
  }

  async listConnections(input: unknown = {}): Promise<{ networks: Connection[] }> {
    const params = ListConnectionsParamsSchema.parse(input);
    const data = (await this.request("GET", "network", params)) as { networks?: unknown[] };
    return { networks: (data.networks ?? []).map((connection) => ConnectionSchema.parse(connection)) };
  }

  async getConnection(input: unknown): Promise<{ network: Connection }> {
    const { hashKey } = GetConnectionParamsSchema.parse(input);
    const data = (await this.request("GET", `network/${hashKey}`)) as { network: unknown };
    return { network: ConnectionSchema.parse(data.network) };
  }

  async searchConnections(input: unknown): Promise<{ networks: Connection[] }> {
    const params = SearchConnectionsParamsSchema.parse(input);
    const data = (await this.request("GET", "network", {
      q: params.query,
      order: params.order,
      column: params.column,
    })) as { networks?: unknown[] };
    return { networks: (data.networks ?? []).map((connection) => ConnectionSchema.parse(connection)) };
  }

  async listTrash(input: unknown = {}): Promise<{ trash: TrashItem[] }> {
    const params = ListTrashParamsSchema.parse(input);
    const data = (await this.request("GET", "trash", params)) as { trash?: unknown[] };
    return { trash: (data.trash ?? []).map((item) => TrashItemSchema.parse(item)) };
  }
}
