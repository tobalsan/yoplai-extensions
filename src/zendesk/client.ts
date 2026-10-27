import {
  AddInternalNoteParamsSchema,
  HelpCenterSectionSchema,
  ArticleSchema,
  ArticleAttachmentSchema,
  CreateArticleParamsSchema,
  UpdateArticleParamsSchema,
  ArchiveArticleParamsSchema,
  ListArticlesParamsSchema,
  ListHelpCenterSectionsParamsSchema,
  CommentSchema,
  GetTicketParamsSchema,
  GroupSchema,
  ListAgentsParamsSchema,
  ListGroupsParamsSchema,
  ListTicketsParamsSchema,
  SearchTicketsParamsSchema,
  TicketSchema,
  UpdateTicketParamsSchema,
  UserSchema,
  type Comment,
  type Group,
  type Ticket,
  type User,
} from "./models.js";
import {
  ZendeskAuthError,
  ZendeskConnectionError,
  ZendeskError,
  ZendeskNotFoundError,
  ZendeskRateLimitError,
  ZendeskValidationError,
} from "./errors.js";
import { setTimeout as sleep } from "node:timers/promises";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Basic auth with an account email and API token, or an OAuth bearer token against a base URL. */
export type ZendeskClientOptions = { timeoutMs?: number } & (
  | { subdomain: string; email: string; apiKey: string }
  | { accessToken: string; baseUrl: string }
);

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

export class ZendeskClient {
  readonly timeoutMs: number;
  readonly baseUrl: string;
  private readonly authorization: string;

  constructor(options: ZendeskClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000;
    if ("accessToken" in options) {
      this.baseUrl = options.baseUrl.replace(/\/+$/, "");
      this.authorization = `Bearer ${options.accessToken}`;
    } else {
      this.baseUrl = `https://${options.subdomain}.zendesk.com`;
      this.authorization = `Basic ${Buffer.from(`${options.email}/token:${options.apiKey}`).toString("base64")}`;
    }
  }

  private async request(
    method: string,
    path: string,
    query?: Array<[string, string]>,
    body?: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of query ?? []) {
      url.searchParams.append(key, value);
    }

    const payload = body instanceof FormData ? body : body ? JSON.stringify(mapDeep(body as JsonValue, toSnakeCase)) : undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        signal?.throwIfAborted();
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            Authorization: this.authorization,
            ...(typeof payload === "string" ? { "Content-Type": "application/json" } : {}),
          },
          body: payload,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });

        const correlationId =
          response.headers.get("x-correlation-id") ?? response.headers.get("x-request-id") ?? undefined;

        if (response.status === 429) {
          if (attempt < 3) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, undefined, { signal });
            continue;
          }
          throw new ZendeskRateLimitError("Rate limit exceeded", {
            endpoint: path,
            status: 429,
            correlationId,
          });
        }

        if ((response.status === 403 || (response.status === 422 && !(body instanceof FormData))) &&
            (method === "POST" || method === "PUT" || method === "DELETE") && path.startsWith("/api/v2/help_center/")) {
          throw this.helpCenterRightsError(path, response.status, await this.readErrorBody(response), correlationId);
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
            await sleep((attempt + 1) * 250, undefined, { signal });
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

  private helpCenterRightsError(path: string, status: number, responseBody: string, correlationId?: string): ZendeskError {
    return new ZendeskError(
      `The connected user lacks Help Center rights to create, edit, or publish in this permission group. Try creating a draft (draft: true) or ask a Guide admin: ${responseBody}`,
      { endpoint: path, status, correlationId, responseBody },
    );
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

  async updateTicket(input: unknown): Promise<{ ticket: Ticket }> {
    const { ticketId, addTags, removeTags, ...fields } = UpdateTicketParamsSchema.parse(input);
    const ticket = {
      ...fields,
      ...(addTags ? { additionalTags: addTags } : {}),
      ...(removeTags ? { removeTags } : {}),
    };
    if (Object.keys(ticket).length === 0) {
      throw new ZendeskValidationError("update_ticket needs at least one field to change");
    }
    return this.putTicket(ticketId, ticket);
  }

  async addInternalNote(input: unknown): Promise<{ ticket: Ticket }> {
    const { ticketId, body } = AddInternalNoteParamsSchema.parse(input);
    return this.putTicket(ticketId, { comment: { body, public: false } });
  }

  async listGroups(input: unknown = {}): Promise<{ groups: Group[]; nextPageCursor?: string; hasMore?: boolean }> {
    const { pageSize, pageCursor } = ListGroupsParamsSchema.parse(input);
    const page = await this.listPage("/api/v2/groups.json", "groups", pageSize, pageCursor);
    return { groups: page.items.map((group) => GroupSchema.parse(group)), ...page.meta };
  }

  /** Agents and admins (the users tickets can be assigned to), optionally scoped to one group. */
  async listAgents(input: unknown = {}): Promise<{ agents: User[]; nextPageCursor?: string; hasMore?: boolean }> {
    const { groupId, pageSize, pageCursor } = ListAgentsParamsSchema.parse(input);
    const path = groupId === undefined ? "/api/v2/users.json" : `/api/v2/groups/${groupId}/users.json`;
    const page = await this.listPage(path, "users", pageSize, pageCursor, [
      ["role[]", "agent"],
      ["role[]", "admin"],
    ]);
    return { agents: page.items.map((user) => UserSchema.parse(user)), ...page.meta };
  }

  async listHelpCenterSections(input: unknown = {}) {
    const { categoryId, pageSize, pageCursor } = ListHelpCenterSectionsParamsSchema.parse(input);
    const path = categoryId === undefined ? "/api/v2/help_center/sections.json" : `/api/v2/help_center/categories/${categoryId}/sections.json`;
    const query: Array<[string, string]> = [["page[size]", String(pageSize)], ["include", "categories"]];
    if (pageCursor) query.push(["page[after]", pageCursor]);
    const data = (await this.request("GET", path, query)) as {
      sections?: Array<{ categoryId?: number }>;
      categories?: Array<{ id: number; name?: string }>;
      meta?: { afterCursor?: string; hasMore?: boolean };
    };
    return {
      sections: (data.sections ?? []).map((section) => HelpCenterSectionSchema.parse({
        ...section,
        categoryName: data.categories?.find((category) => category.id === section.categoryId)?.name,
      })),
      nextPageCursor: data.meta?.afterCursor ?? undefined,
      hasMore: data.meta?.hasMore ?? undefined,
    };
  }

  async listArticles(input: unknown) {
    const { sectionId, pageSize, pageCursor } = ListArticlesParamsSchema.parse(input);
    const page = await this.listPage(`/api/v2/help_center/sections/${sectionId}/articles.json`, "articles", pageSize, pageCursor);
    return { articles: page.items.map((article) => ArticleSchema.parse(article)), ...page.meta };
  }

  async createArticle(input: unknown) {
    const { sectionId, notifySubscribers, ...article } = CreateArticleParamsSchema.parse(input);
    const data = (await this.request("POST", `/api/v2/help_center/sections/${sectionId}/articles.json`, undefined, { article, notifySubscribers })) as { article: unknown };
    return { article: ArticleSchema.parse(data.article) };
  }

  async uploadArticleAttachment(params: { articleId: number; fileName: string; mimeType: string; bytes: Uint8Array; inline?: boolean }, signal?: AbortSignal) {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(params.bytes)], { type: params.mimeType }), params.fileName);
    form.set("inline", String(params.inline ?? true));
    const data = (await this.request("POST", `/api/v2/help_center/articles/${params.articleId}/attachments.json`, undefined, form, signal)) as { articleAttachment: unknown };
    return { attachment: ArticleAttachmentSchema.parse(data.articleAttachment) };
  }

  async updateArticle(input: unknown) {
    const { articleId, locale, labelNames, ...translation } = UpdateArticleParamsSchema.parse(input);
    if (Object.keys(translation).length === 0 && labelNames === undefined) {
      throw new ZendeskValidationError("update_article needs at least one field to change");
    }
    if (Object.keys(translation).length === 0) {
      const data = (await this.request("PUT", `/api/v2/help_center/articles/${articleId}.json`, undefined, { article: { labelNames } })) as { article: unknown };
      return { article: ArticleSchema.parse(data.article) };
    }
    const data = (await this.request("PUT", `/api/v2/help_center/articles/${articleId}/translations/${encodeURIComponent(locale)}.json`, undefined, { translation })) as { translation: { title?: string; locale?: string; draft?: boolean; htmlUrl?: string } };
    const { title, draft, htmlUrl } = data.translation;
    let metadata = {};
    if (labelNames !== undefined) {
      try {
        const result = (await this.request("PUT", `/api/v2/help_center/articles/${articleId}.json`, undefined, { article: { labelNames } })) as { article: unknown };
        metadata = ArticleSchema.parse(result.article);
      } catch (error) {
        throw new ZendeskError(
          `Article ${articleId} translation (${locale}) was saved, but updating labels failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof ZendeskError ? error : {},
        );
      }
    }
    return { article: ArticleSchema.parse({ ...metadata, id: articleId, title, locale: data.translation.locale, draft, htmlUrl }) };
  }

  async archiveArticle(input: unknown) {
    const { articleId } = ArchiveArticleParamsSchema.parse(input);
    const path = `/api/v2/help_center/articles/${articleId}.json`;
    let data: { article: unknown };
    try {
      data = (await this.request("GET", path)) as { article: unknown };
    } catch (error) {
      if (error instanceof ZendeskAuthError && error.status === 403) {
        throw this.helpCenterRightsError(path, 403, error.responseBody ?? "", error.correlationId);
      }
      throw error;
    }
    const article = ArticleSchema.parse(data.article);
    if (article.draft !== true) {
      throw new ZendeskValidationError(
        `Article ${articleId} is published. Only draft articles can be archived. Ask a Guide admin to archive a published article.`,
      );
    }
    await this.request("DELETE", path);
    return { archived: true as const, articleId, title: article.title };
  }

  private async listPage(
    path: string,
    key: string,
    pageSize: number,
    pageCursor: string | undefined,
    extraQuery: Array<[string, string]> = [],
  ): Promise<{ items: unknown[]; meta: { nextPageCursor?: string; hasMore?: boolean } }> {
    const query: Array<[string, string]> = [["page[size]", String(pageSize)], ...extraQuery];
    if (pageCursor) query.push(["page[after]", pageCursor]);
    const data = (await this.request("GET", path, query)) as Record<string, unknown> & {
      meta?: { afterCursor?: string; hasMore?: boolean };
    };
    return {
      items: (data[key] as unknown[] | undefined) ?? [],
      meta: { nextPageCursor: data.meta?.afterCursor ?? undefined, hasMore: data.meta?.hasMore ?? undefined },
    };
  }

  private async putTicket(ticketId: number, ticket: Record<string, unknown>): Promise<{ ticket: Ticket }> {
    const data = (await this.request("PUT", `/api/v2/tickets/${ticketId}.json`, undefined, { ticket })) as {
      ticket: unknown;
    };
    return { ticket: TicketSchema.parse(data.ticket) };
  }
}
