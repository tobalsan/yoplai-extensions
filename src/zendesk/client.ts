import {
  CommentSchema,
  GetTicketParamsSchema,
  ListTicketsParamsSchema,
  SearchTicketsParamsSchema,
  TicketSchema,
  type Comment,
  type Ticket,
} from "./models.js";
import {
  ZendeskAuthError,
  ZendeskConnectionError,
  ZendeskError,
  ZendeskNotFoundError,
  ZendeskRateLimitError,
  ZendeskValidationError,
} from "./errors.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ZendeskClientOptions {
  subdomain: string;
  email: string;
  apiKey: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ZendeskClient {
  readonly subdomain: string;
  readonly email: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly baseUrl: string;

  constructor({ subdomain, email, apiKey, timeoutMs = 30000 }: ZendeskClientOptions) {
    this.subdomain = subdomain;
    this.email = email;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.baseUrl = `https://${subdomain}.zendesk.com`;
  }

  private async request(
    method: string,
    path: string,
    query?: Array<[string, string]>,
    body?: Record<string, unknown>,
  ): Promise<JsonValue> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of query ?? []) {
      url.searchParams.set(key, value);
    }

    const payload = body ? JSON.stringify(mapDeep(body as JsonValue, toSnakeCase)) : undefined;
    const auth = `Basic ${Buffer.from(`${this.email}/token:${this.apiKey}`).toString("base64")}`;

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
          throw new ZendeskRateLimitError("Rate limit exceeded", {
            endpoint: path,
            status: 429,
            correlationId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          const responseBody = await this.readErrorBody(response);
          throw new ZendeskAuthError(`Authentication failed for ${path}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        if (response.status === 404) {
          const responseBody = await this.readErrorBody(response);
          throw new ZendeskNotFoundError(`Resource not found: ${path}: ${responseBody}`, {
            endpoint: path,
            status: 404,
            correlationId,
            responseBody,
          });
        }

        if (response.status === 400 || response.status === 422) {
          const responseBody = await this.readErrorBody(response);
          throw new ZendeskValidationError(`Validation failed for ${path}: ${responseBody}`, {
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
          throw new ZendeskError(`Server error for ${path}: ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        if (!response.ok) {
          const responseBody = await this.readErrorBody(response);
          throw new ZendeskError(`Request failed for ${path}: ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            correlationId,
            responseBody,
          });
        }

        const text = await response.text();
        return text ? mapDeep(JSON.parse(text) as JsonValue, toCamelCase) : {};
      } catch (error) {
        if (error instanceof ZendeskError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new ZendeskConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new ZendeskRateLimitError("Rate limit exceeded", { endpoint: path, status: 429 });
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      const body = await response.text();
      return body.slice(0, 500);
    } catch {
      return "";
    }
  }

  async listTickets(input: unknown = {}): Promise<{
    tickets: Ticket[];
    nextPageCursor?: string;
    hasMore?: boolean;
  }> {
    const params = ListTicketsParamsSchema.parse(input);
    const query: Array<[string, string]> = [
      ["page[size]", String(params.pageSize)],
      ["sort", params.sort],
    ];
    if (params.pageCursor) {
      query.push(["page[after]", params.pageCursor]);
    }
    const data = (await this.request("GET", "/api/v2/tickets.json", query)) as {
      tickets?: unknown[];
      meta?: { afterCursor?: string; hasMore?: boolean };
    };
    return {
      tickets: (data.tickets ?? []).map((ticket) => TicketSchema.parse(ticket)),
      nextPageCursor: data.meta?.afterCursor ?? undefined,
      hasMore: data.meta?.hasMore ?? undefined,
    };
  }

  async searchTickets(input: unknown): Promise<{
    tickets: Ticket[];
    count?: number;
    nextPage?: string;
  }> {
    const params = SearchTicketsParamsSchema.parse(input);
    const query: Array<[string, string]> = [
      ["query", `type:ticket ${params.query}`],
      ["per_page", String(params.pageSize)],
      ["page", String(params.page)],
    ];
    if (params.sortBy) query.push(["sort_by", params.sortBy]);
    if (params.sortOrder) query.push(["sort_order", params.sortOrder]);

    const data = (await this.request("GET", "/api/v2/search.json", query)) as {
      results?: unknown[];
      count?: number;
      nextPage?: string | null;
    };
    return {
      tickets: (data.results ?? []).map((ticket) => TicketSchema.parse(ticket)),
      count: data.count,
      nextPage: data.nextPage ?? undefined,
    };
  }

  async getTicket(input: unknown): Promise<{ ticket: Ticket }> {
    const { ticketId } = GetTicketParamsSchema.parse(input);
    const data = (await this.request("GET", `/api/v2/tickets/${ticketId}.json`)) as {
      ticket: unknown;
    };
    const ticket = TicketSchema.parse(data.ticket);

    const commentsData = (await this.request(
      "GET",
      `/api/v2/tickets/${ticketId}/comments.json`,
    )) as { comments?: unknown[] };
    const comments: Comment[] = (commentsData.comments ?? []).map((comment) =>
      CommentSchema.parse(comment),
    );

    return { ticket: { ...ticket, comments } };
  }
}
