import mammoth from "mammoth";

import {
  ConfluenceAuthError,
  ConfluenceConflictError,
  ConfluenceConnectionError,
  ConfluenceError,
  ConfluenceNotFoundError,
  ConfluenceRateLimitError,
  ConfluenceServerError,
  ConfluenceValidationError,
} from "./errors.js";
import { type ConfluenceBodyFormat, type ConfluenceConfig } from "./models.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function extractRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-arequestid") ??
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    undefined
  );
}

function looksLikePdf(url: string, filename?: string, contentType?: string): boolean {
  const hint = `${url} ${filename ?? ""} ${contentType ?? ""}`.toLowerCase();
  return hint.includes("pdf") || hint.includes("application/pdf");
}

function looksLikeDocx(url: string, filename?: string, contentType?: string): boolean {
  const hint = `${url} ${filename ?? ""} ${contentType ?? ""}`.toLowerCase();
  return (
    hint.includes("docx") ||
    hint.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  );
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ConfluenceClientOptions extends ConfluenceConfig {}

export class ConfluenceClient {
  readonly subdomain: string;
  readonly email: string;
  readonly apiToken: string;
  readonly timeoutMs: number;
  readonly baseUrl: string;
  readonly space?: string;
  private resolvedSpaceId?: string;

  constructor(options: ConfluenceClientOptions) {
    this.subdomain = options.subdomain;
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs;
    this.space = options.confluenceSpace;
    this.baseUrl = `https://${options.subdomain}.atlassian.net/wiki`;
  }

  private scopeCql(cql: string): string {
    if (!this.space) return cql;
    const match = cql.match(/\bORDER\s+BY\b/i);
    const escapedKey = this.space.replace(/"/g, '\\"');
    const filter = `space = "${escapedKey}"`;
    if (match && match.index !== undefined) {
      const predicate = cql.slice(0, match.index).trim();
      const ordering = cql.slice(match.index).trim();
      const wrapped = predicate ? `(${predicate}) AND ${filter}` : filter;
      return `${wrapped} ${ordering}`;
    }
    const trimmed = cql.trim();
    return trimmed ? `(${trimmed}) AND ${filter}` : filter;
  }

  private async getScopedSpaceId(): Promise<string> {
    if (!this.space) {
      throw new ConfluenceError("No confluenceSpace configured", { endpoint: "(scope)" });
    }
    if (this.resolvedSpaceId) return this.resolvedSpaceId;
    const response = await this.requestJson("GET", "/api/v2/spaces", undefined, {
      keys: this.space,
      limit: 1,
    });
    const results = Array.isArray(response.results) ? response.results : [];
    const first = results[0];
    if (!isPlainObject(first) || (typeof first.id !== "string" && typeof first.id !== "number")) {
      throw new ConfluenceValidationError(`Confluence space "${this.space}" not found`, {
        endpoint: "/api/v2/spaces",
      });
    }
    this.resolvedSpaceId = String(first.id);
    return this.resolvedSpaceId;
  }

  async search(input: {
    cql: string;
    limit?: number;
    start?: number;
    expand?: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.requestJson("GET", "/rest/api/search", undefined, {
      cql: this.scopeCql(input.cql),
      limit: input.limit,
      start: input.start,
      expand: input.expand,
    });
    return this.decorateSearchResults(response);
  }

  async listSpacePages(input: {
    spaceId?: string;
    depth?: "all" | "root";
    sort?:
      | "id"
      | "-id"
      | "created-date"
      | "-created-date"
      | "modified-date"
      | "-modified-date"
      | "title"
      | "-title";
    status?: Array<"current" | "archived" | "deleted" | "trashed">;
    bodyFormat?: ConfluenceBodyFormat;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const spaceId =
      input.spaceId ?? (this.space ? await this.getScopedSpaceId() : undefined);
    if (!spaceId) {
      throw new ConfluenceValidationError(
        "spaceId is required when confluenceSpace is not configured",
        { endpoint: "/api/v2/spaces/{id}/pages" },
      );
    }
    const response = await this.requestJson(
      "GET",
      `/api/v2/spaces/${encodeURIComponent(spaceId)}/pages`,
      undefined,
      {
        depth: input.depth,
        sort: input.sort,
        status: input.status,
        "body-format": input.bodyFormat,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return this.decorateResultList(response);
  }

  async listSpaces(input: {
    keys?: string;
    type?: "global" | "collaboration" | "knowledge_base" | "personal";
    status?: "current" | "archived";
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", "/api/v2/spaces", undefined, {
      keys: this.space ?? input.keys,
      type: input.type,
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  async createPage(input: {
    spaceId?: string;
    parentId?: string;
    title: string;
    body: string;
  }): Promise<Record<string, unknown>> {
    const scopedSpaceId = this.space ? await this.getScopedSpaceId() : undefined;
    const spaceId = input.spaceId ?? scopedSpaceId;
    if (!spaceId) {
      throw new ConfluenceValidationError(
        "spaceId is required when confluenceSpace is not configured",
        { endpoint: "/api/v2/pages" },
      );
    }
    if (scopedSpaceId && input.spaceId && input.spaceId !== scopedSpaceId) {
      throw new ConfluenceValidationError(
        "spaceId does not match configured confluenceSpace",
        { endpoint: "/api/v2/pages" },
      );
    }

    const response = await this.requestJson("POST", "/api/v2/pages", {
      spaceId,
      parentId: input.parentId,
      status: "current",
      title: input.title,
      body: { representation: "storage", value: input.body },
    });
    return this.decoratePage(response);
  }

  async replacePage(input: {
    pageId: string;
    title?: string;
    body: string;
  }): Promise<Record<string, unknown>> {
    const path = `/api/v2/pages/${encodeURIComponent(input.pageId)}`;
    const current = await this.requestJson("GET", path);
    const currentTitle = typeof current.title === "string" ? current.title : undefined;
    const version = isPlainObject(current.version) ? current.version : undefined;
    const currentVersion = typeof version?.number === "number" ? version.number : undefined;
    if (!currentTitle && !input.title) {
      throw new ConfluenceValidationError("Current page title is missing", { endpoint: path });
    }
    if (currentVersion === undefined) {
      throw new ConfluenceValidationError("Current page version is missing", { endpoint: path });
    }

    const response = await this.requestJson("PUT", path, {
      id: input.pageId,
      status: "current",
      title: input.title ?? currentTitle,
      body: { representation: "storage", value: input.body },
      version: { number: currentVersion + 1 },
    });
    return this.decoratePage(response);
  }

  async getPage(input: {
    pageId: string;
    bodyFormat?: ConfluenceBodyFormat;
  }): Promise<Record<string, unknown>> {
    const response = await this.requestJson(
      "GET",
      `/api/v2/pages/${encodeURIComponent(input.pageId)}`,
      undefined,
      {
        "body-format": input.bodyFormat ?? "storage",
      },
    );
    return this.decoratePage(response);
  }

  async getPageChildren(input: {
    pageId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.requestJson(
      "GET",
      `/api/v2/pages/${encodeURIComponent(input.pageId)}/children`,
      undefined,
      {
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return this.decorateResultList(response);
  }

  async getPageAncestors(input: {
    pageId: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const response = await this.requestJson(
      "GET",
      `/api/v2/pages/${encodeURIComponent(input.pageId)}/ancestors`,
      undefined,
      {
        limit: input.limit,
      },
    );
    return this.decorateResultList(response);
  }

  async listAttachments(input: {
    pageId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "GET",
      `/api/v2/pages/${encodeURIComponent(input.pageId)}/attachments`,
      undefined,
      {
        limit: input.limit,
        cursor: input.cursor,
      },
    );
  }

  async listLabels(input: {
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    if (this.space) {
      const spaceId = await this.getScopedSpaceId();
      return await this.requestJson(
        "GET",
        `/api/v2/spaces/${encodeURIComponent(spaceId)}/labels`,
        undefined,
        {
          limit: input.limit,
          cursor: input.cursor,
        },
      );
    }
    return await this.requestJson("GET", "/api/v2/labels", undefined, {
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  async getPagesByLabel(input: {
    labelId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const spaceId = this.space ? await this.getScopedSpaceId() : undefined;
    const response = await this.requestJson(
      "GET",
      `/api/v2/labels/${encodeURIComponent(input.labelId)}/pages`,
      undefined,
      {
        "space-id": spaceId,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return this.decorateResultList(response);
  }

  async validate(): Promise<Record<string, unknown>> {
    const spaces = await this.requestJson("GET", "/api/v2/spaces", undefined, {
      keys: this.space,
      limit: 1,
    });
    const results = Array.isArray(spaces.results) ? spaces.results : [];
    let scopedSpace: { key: string; id: string } | undefined;
    if (this.space) {
      const first = results[0];
      if (!isPlainObject(first) || (typeof first.id !== "string" && typeof first.id !== "number")) {
        throw new ConfluenceValidationError(
          `Confluence space "${this.space}" not found`,
          { endpoint: "/api/v2/spaces" },
        );
      }
      this.resolvedSpaceId = String(first.id);
      scopedSpace = { key: this.space, id: this.resolvedSpaceId };
    }
    return {
      ok: true,
      message: "Confluence API reachable",
      subdomain: this.subdomain,
      sampleSpaceCount: results.length,
      ...(scopedSpace ? { scopedSpace } : {}),
    };
  }

  async downloadAndExtractFile(input: {
    url: string;
    filename?: string;
    contentType?: string;
  }): Promise<Record<string, unknown>> {
    const useAuth = this.shouldAuthenticate(input.url);
    const headers: Record<string, string> = useAuth
      ? { Authorization: this.authHeader() }
      : {};

    const response = await fetch(input.url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const responseBody = await this.readErrorMessage(response);
      throw new ConfluenceError(`File download failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
        endpoint: input.url,
        status: response.status,
        responseBody,
      });
    }

    const contentType = input.contentType ?? response.headers.get("content-type") ?? undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = await this.extractText(buffer, input.url, input.filename, contentType);

    return {
      text,
      source: {
        url: input.url,
        filename: input.filename ?? null,
        contentType: contentType ?? null,
        bytes: buffer.byteLength,
        authenticated: useAuth,
      },
    };
  }

  private shouldAuthenticate(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.host === `${this.subdomain}.atlassian.net`;
    } catch {
      return false;
    }
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");
    return `Basic ${token}`;
  }

  private buildWebUrl(item: Record<string, unknown>): string | undefined {
    const links = isPlainObject(item._links) ? item._links : undefined;
    const webui = links && typeof links.webui === "string" ? links.webui : undefined;
    if (webui) {
      const path = webui.startsWith("/") ? webui : `/${webui}`;
      return `https://${this.subdomain}.atlassian.net/wiki${path}`;
    }
    const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : undefined;
    if (id) {
      return `https://${this.subdomain}.atlassian.net/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
    }
    return undefined;
  }

  private decoratePage(page: Record<string, unknown>): Record<string, unknown> {
    const webUrl = this.buildWebUrl(page);
    return webUrl ? { ...page, webUrl } : page;
  }

  private decorateResultList(response: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(response.results)) {
      return response;
    }
    const results = response.results.map((entry) =>
      isPlainObject(entry) ? this.decoratePage(entry) : entry,
    );
    return { ...response, results };
  }

  private decorateSearchResults(response: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(response.results)) {
      return response;
    }
    const results = response.results.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const merged: Record<string, unknown> = { ...entry };
      const links = isPlainObject(entry._links) ? entry._links : undefined;
      const webui = links && typeof links.webui === "string" ? links.webui : undefined;
      if (webui) {
        const path = webui.startsWith("/") ? webui : `/${webui}`;
        merged.webUrl = `https://${this.subdomain}.atlassian.net/wiki${path}`;
      } else if (isPlainObject(entry.content)) {
        const contentWebUrl = this.buildWebUrl(entry.content);
        if (contentWebUrl) merged.webUrl = contentWebUrl;
      }
      return merged;
    });
    return { ...response, results };
  }

  private async extractText(
    buffer: Buffer,
    url: string,
    filename?: string,
    contentType?: string,
  ): Promise<string> {
    if (looksLikePdf(url, filename, contentType)) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useWorkerFetch: false,
      });
      const document = await task.promise;
      const parts: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const lines = content.items
          .map((item) => (item as { str?: string }).str ?? "")
          .filter(Boolean);
        if (lines.length > 0) {
          parts.push(lines.join(" "));
        }
      }
      return normalizeText(parts.join("\n\n"));
    }

    if (looksLikeDocx(url, filename, contentType)) {
      const result = await mammoth.extractRawText({ buffer });
      return normalizeText(result.value);
    }

    return buffer.toString("utf8");
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(compact(query ?? {}))) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const requestBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: this.authHeader(),
            Accept: "application/json",
            ...(requestBody ? { "Content-Type": "application/json" } : {}),
          },
          body: requestBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const requestId = extractRequestId(response);

        if (response.status === 429) {
          if (attempt < 3) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
            continue;
          }
          throw new ConfluenceRateLimitError("Confluence rate limit exceeded", {
            endpoint: path,
            status: 429,
            requestId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          const responseBody = await this.readErrorMessage(response);
          throw new ConfluenceAuthError(
            `Confluence authentication failed with status ${response.status}: ${responseBody}`,
            {
              endpoint: path,
              status: response.status,
              requestId,
              responseBody,
            },
          );
        }

        if (response.status === 404) {
          const responseBody = await this.readErrorMessage(response);
          throw new ConfluenceNotFoundError(`Confluence resource not found: ${path}: ${responseBody}`, {
            endpoint: path,
            status: 404,
            requestId,
            responseBody,
          });
        }

        if (response.status === 409) {
          const responseBody = await this.readErrorMessage(response);
          throw new ConfluenceConflictError(`Confluence request failed with status ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (response.status === 400 || response.status === 422) {
          const responseBody = await this.readErrorMessage(response);
          throw new ConfluenceValidationError(`Confluence request failed with status ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (response.status >= 500) {
          if (attempt < 3) {
            await sleep((attempt + 1) * 250);
            continue;
          }
          const detail = await this.readErrorMessage(response);
          throw new ConfluenceServerError(
            `Confluence server error with status ${response.status}: ${detail}`,
            {
              endpoint: path,
              status: response.status,
              requestId,
              responseBody: detail,
            },
          );
        }

        if (!response.ok) {
          const responseBody = await this.readErrorMessage(response);
          throw new ConfluenceError(`Confluence request failed with status ${response.status}: ${responseBody}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        const text = await response.text();
        if (!text) {
          return {};
        }
        return JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ConfluenceError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new ConfluenceConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new ConfluenceRateLimitError("Confluence rate limit exceeded", {
      endpoint: path,
      status: 429,
    });
  }

  private async readErrorMessage(response: Response): Promise<string> {
    return (await response.text().catch(() => "")).slice(0, 500);
  }
}
