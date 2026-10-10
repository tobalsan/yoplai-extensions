import mammoth from "mammoth";

import {
  NotionAuthError,
  NotionConnectionError,
  NotionError,
  NotionFileExtractionError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionServerError,
  NotionValidationError,
} from "./errors.js";
import { type NotionConfig } from "./models.js";

const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function mapKeysDeep(value: unknown, mapper: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapKeysDeep(item, mapper));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [mapper(key), mapKeysDeep(nested, mapper)]),
    );
  }
  return value;
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function extractRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("x-notion-request-id") ??
    response.headers.get("request-id") ??
    undefined
  );
}

function withPropertyValues<T extends Record<string, unknown>>(properties: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, mapKeysDeep(value, toSnakeCase)]),
  );
}

function withBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((block) => mapKeysDeep(block, toSnakeCase));
}

function normalizeRichTextItem(item: unknown): unknown {
  if (typeof item === "string") {
    return { type: "text", text: { content: item } };
  }
  if (isPlainObject(item) && typeof item.text === "string") {
    return {
      ...item,
      type: typeof item.type === "string" ? item.type : "text",
      text: { content: item.text },
    };
  }
  return item;
}

function normalizePagePropertyValue(value: unknown, property: unknown): unknown {
  const mappedValue = mapKeysDeep(value, toSnakeCase);
  const propertyType =
    isPlainObject(property) && typeof property.type === "string" ? property.type : undefined;
  if (propertyType !== "rich_text") {
    return mappedValue;
  }
  if (typeof mappedValue === "string") {
    return { rich_text: [{ type: "text", text: { content: mappedValue } }] };
  }
  if (isPlainObject(mappedValue) && Array.isArray(mappedValue.rich_text)) {
    return {
      ...mappedValue,
      rich_text: mappedValue.rich_text.map(normalizeRichTextItem),
    };
  }
  return mappedValue;
}

function withPropertyNameMap(properties: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (isPlainObject(prop)) {
      const id = typeof prop.id === "string" ? prop.id : undefined;
      if (id) {
        map[id] = name;
      }
    }
    map[normalizeName(name)] = name;
  }
  return map;
}

function resolvePagePropertyName(page: Record<string, unknown>, key: string): string {
  const properties = isPlainObject(page.properties) ? page.properties : {};
  const map = withPropertyNameMap(properties);
  return map[key] ?? map[normalizeName(key)] ?? key;
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

function normalizeHeadingText(text: string): string {
  return text.trim().toLowerCase();
}

function getBlockId(block: unknown): string | undefined {
  return isPlainObject(block) && typeof block.id === "string" ? block.id : undefined;
}

function getBlockType(block: unknown): string | undefined {
  return isPlainObject(block) && typeof block.type === "string" ? block.type : undefined;
}

function isHeadingBlock(block: unknown): boolean {
  const type = getBlockType(block);
  return Boolean(type && HEADING_TYPES.has(type));
}

function extractRichTextText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((item) => {
      if (!isPlainObject(item)) return "";
      if (typeof item.plain_text === "string") return item.plain_text;
      const text = item.text;
      if (isPlainObject(text) && typeof text.content === "string") return text.content;
      return "";
    })
    .join("");
}

function extractHeadingText(block: unknown): string | undefined {
  const type = getBlockType(block);
  if (!type || !HEADING_TYPES.has(type) || !isPlainObject(block)) return undefined;
  const heading = block[type];
  if (!isPlainObject(heading)) return undefined;
  return extractRichTextText(heading.rich_text);
}

export interface NotionClientOptions extends Omit<NotionConfig, "mode" | "apiKey"> {
  apiKey: string;
}

export class NotionClient {
  readonly apiKey: string;
  readonly notionVersion: string;
  readonly timeoutMs: number;
  readonly baseUrl = "https://api.notion.com/v1";

  constructor(options: NotionClientOptions) {
    this.apiKey = options.apiKey;
    this.notionVersion = options.notionVersion;
    this.timeoutMs = options.timeoutMs;
  }

  async listDataSources(query?: string, pageSize?: number, startCursor?: string): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query,
      filter: {
        property: "object",
        value: "data_source",
      },
      page_size: pageSize,
      start_cursor: startCursor,
    });
  }

  async listPages(query?: string, pageSize?: number, startCursor?: string): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query,
      filter: {
        property: "object",
        value: "page",
      },
      page_size: pageSize,
      start_cursor: startCursor,
    });
  }

  async searchPages(query: string, pageSize?: number, startCursor?: string): Promise<Record<string, unknown>> {
    return await this.listPages(query, pageSize, startCursor);
  }

  async getDataSource(dataSourceId: string): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", `/data_sources/${dataSourceId}`);
  }

  async updateDataSource(input: {
    dataSourceId: string;
    title?: string | unknown[];
    description?: string | unknown[];
    properties?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = compact({
      title: input.title ? mapKeysDeep(input.title, toSnakeCase) : undefined,
      description: input.description ? mapKeysDeep(input.description, toSnakeCase) : undefined,
      properties: input.properties ? withPropertyValues(input.properties) : undefined,
    });
    return await this.requestJson("PATCH", `/data_sources/${input.dataSourceId}`, body);
  }

  async queryDataSource(input: {
    dataSourceId: string;
    filter?: Record<string, unknown>;
    sorts?: unknown[];
    pageSize?: number;
    startCursor?: string;
  }): Promise<Record<string, unknown>> {
    const baseBody = compact({
      filter: input.filter ? mapKeysDeep(input.filter, toSnakeCase) : undefined,
      sorts: input.sorts ? mapKeysDeep(input.sorts, toSnakeCase) : undefined,
      page_size: input.pageSize,
    });

    const results: unknown[] = [];
    let startCursor = input.startCursor;
    let last: Record<string, unknown> = {};
    do {
      const response = await this.requestJson(
        "POST",
        `/data_sources/${input.dataSourceId}/query`,
        compact({ ...baseBody, start_cursor: startCursor }),
      );
      last = response;
      if (Array.isArray(response.results)) {
        results.push(...response.results);
      }
      startCursor =
        response.has_more === true && typeof response.next_cursor === "string"
          ? response.next_cursor
          : undefined;
    } while (startCursor);

    return { ...last, results, has_more: false, next_cursor: null };
  }

  async getPage(pageId: string): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", `/pages/${pageId}`);
  }

  async getPageMarkdown(input: {
    pageId: string;
    includeTranscript?: boolean;
  }): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", `/pages/${input.pageId}/markdown`, undefined, {
      include_transcript: input.includeTranscript,
    });
  }

  async createPage(input: {
    dataSourceId?: string;
    pageId?: string;
    properties?: Record<string, unknown>;
    children?: unknown[];
    markdown?: string;
    icon?: Record<string, unknown>;
    cover?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (Boolean(input.dataSourceId) === Boolean(input.pageId)) {
      throw new NotionValidationError("Exactly one of dataSourceId or pageId is required to create a page.");
    }
    if (input.markdown && input.children) {
      throw new NotionValidationError("markdown and children are mutually exclusive; provide only one.");
    }
    if (
      (!input.properties || Object.keys(input.properties).length === 0) &&
      !input.markdown &&
      (!input.children || input.children.length === 0)
    ) {
      throw new NotionValidationError(
        "create_page would create a blank page. Provide properties (call get_data_source first to learn the property names), or markdown/children for content.",
      );
    }
    const parent = input.dataSourceId
      ? { type: "data_source_id", data_source_id: input.dataSourceId }
      : { type: "page_id", page_id: input.pageId };
    const body = compact({
      parent,
      properties: input.properties ? withPropertyValues(input.properties) : undefined,
      children: input.children ? withBlocks(input.children) : undefined,
      markdown: input.markdown,
      icon: input.icon ? mapKeysDeep(input.icon, toSnakeCase) : undefined,
      cover: input.cover ? mapKeysDeep(input.cover, toSnakeCase) : undefined,
    });
    return await this.requestJson("POST", "/pages", body);
  }

  async updatePageProperties(input: {
    pageId: string;
    properties: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (!input.properties || Object.keys(input.properties).length === 0) {
      throw new NotionValidationError(
        "properties is empty; nothing would be updated. Provide property values keyed by property name, or use update_page_markdown to edit page content.",
      );
    }
    const page = (await this.getPage(input.pageId)) as Record<string, unknown>;
    const pageProperties = isPlainObject(page.properties) ? page.properties : {};
    const mappedProperties = Object.fromEntries(
      Object.entries(input.properties).map(([key, value]) => {
        const propertyName = resolvePagePropertyName(page, key);
        return [propertyName, normalizePagePropertyValue(value, pageProperties[propertyName])];
      }),
    );
    return await this.requestJson("PATCH", `/pages/${input.pageId}`, {
      properties: mappedProperties,
    });
  }

  async updatePageMarkdown(input: {
    pageId: string;
    mode: "update_content" | "replace_content";
    contentUpdates?: Array<{ oldStr: string; newStr: string; replaceAllMatches?: boolean }>;
    newStr?: string;
    allowDeletingContent?: boolean;
  }): Promise<Record<string, unknown>> {
    if (input.mode === "update_content") {
      if (!input.contentUpdates || input.contentUpdates.length === 0) {
        throw new NotionValidationError("contentUpdates is required and must be non-empty for mode update_content.");
      }
      if (input.contentUpdates.length > 100) {
        throw new NotionValidationError("contentUpdates supports at most 100 items.");
      }
      const body = compact({
        type: "update_content",
        update_content: {
          content_updates: input.contentUpdates.map((update) =>
            compact({
              old_str: update.oldStr,
              new_str: update.newStr,
              replace_all_matches: update.replaceAllMatches,
            }),
          ),
        },
        allow_deleting_content: input.allowDeletingContent,
      });
      return await this.requestJson("PATCH", `/pages/${input.pageId}/markdown`, body);
    }

    if (!input.newStr) {
      throw new NotionValidationError("newStr is required for mode replace_content.");
    }
    const body = compact({
      type: "replace_content",
      replace_content: {
        new_str: input.newStr,
      },
      allow_deleting_content: input.allowDeletingContent,
    });
    return await this.requestJson("PATCH", `/pages/${input.pageId}/markdown`, body);
  }

  async getBlocks(input: {
    blockId: string;
    pageSize?: number;
    startCursor?: string;
  }): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", `/blocks/${input.blockId}/children`, undefined, {
      page_size: input.pageSize,
      start_cursor: input.startCursor,
    });
  }

  async appendBlocks(input: {
    blockId: string;
    children: unknown[];
  }): Promise<Record<string, unknown>> {
    if (!input.children || input.children.length === 0) {
      throw new NotionValidationError(
        "children is empty; nothing would be appended. Provide block objects, or use update_page_markdown to write content as Markdown.",
      );
    }
    return await this.requestJson("PATCH", `/blocks/${input.blockId}/children`, {
      children: withBlocks(input.children),
    });
  }

  async deleteBlock(blockId: string): Promise<Record<string, unknown>> {
    return await this.requestJson("DELETE", `/blocks/${blockId}`);
  }

  async replaceChildBlocks(input: {
    blockId: string;
    headingTexts: string[];
    headingTypes?: Array<"heading_1" | "heading_2" | "heading_3">;
    children: unknown[];
    pageSize?: number;
  }): Promise<Record<string, unknown>> {
    const children = await this.getAllBlockChildren(input.blockId, input.pageSize);
    const allowedHeadingTypes = input.headingTypes ? new Set(input.headingTypes) : undefined;
    const targetHeadings = new Set(input.headingTexts.map(normalizeHeadingText));
    const matchedHeadingTexts: string[] = [];
    const idsToDelete: string[] = [];

    for (let index = 0; index < children.length; index += 1) {
      const block = children[index];
      const type = getBlockType(block);
      const headingText = extractHeadingText(block);
      if (
        !type ||
        !headingText ||
        !targetHeadings.has(normalizeHeadingText(headingText)) ||
        (allowedHeadingTypes && !allowedHeadingTypes.has(type as "heading_1" | "heading_2" | "heading_3"))
      ) {
        continue;
      }

      matchedHeadingTexts.push(headingText.trim());
      for (let nestedIndex = index; nestedIndex < children.length; nestedIndex += 1) {
        const nestedBlock = children[nestedIndex];
        if (nestedIndex > index && isHeadingBlock(nestedBlock)) {
          break;
        }
        const id = getBlockId(nestedBlock);
        if (id) {
          idsToDelete.push(id);
        }
      }
    }

    if (input.children.length > 0) {
      await this.appendBlocks({ blockId: input.blockId, children: input.children });
    }
    for (const blockId of idsToDelete) {
      await this.deleteBlock(blockId);
    }

    return {
      object: "replace_child_blocks_result",
      blockId: input.blockId,
      matchedHeadingTexts: Array.from(new Set(matchedHeadingTexts)),
      deletedBlockCount: idsToDelete.length,
      appendedBlockCount: input.children.length,
      deletedBlockIds: idsToDelete,
    };
  }

  async downloadAndExtractFile(input: {
    url: string;
    filename?: string;
    contentType?: string;
  }): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(input.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new NotionFileExtractionError(`File download could not be completed: ${message}`, {
        code: "FILE_DOWNLOAD_FAILED",
        retryable: true,
        endpoint: input.url,
      });
    }

    if (!response.ok) {
      const responseBody = await this.readResponseBody(response);
      throw new NotionFileExtractionError(`File download failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
        code: response.status === 401 || response.status === 403 ? "SIGNED_URL_EXPIRED" : "FILE_DOWNLOAD_FAILED",
        retryable: response.status >= 500,
        endpoint: input.url,
        status: response.status,
        responseBody,
      });
    }

    const contentType = input.contentType ?? response.headers.get("content-type") ?? undefined;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new NotionFileExtractionError(`File download body could not be read: ${message}`, {
        code: "FILE_DOWNLOAD_FAILED",
        retryable: true,
        endpoint: input.url,
      });
    }
    let text: string;
    try {
      text = await this.extractText(buffer, input.url, input.filename, contentType);
    } catch (error) {
      if (error instanceof NotionFileExtractionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const versionMismatch = /API version .*Worker version/i.test(message);
      throw new NotionFileExtractionError(
        versionMismatch
          ? "PDF extraction cannot start because the bundled PDF.js API and worker versions differ. Reinstall the extension dependencies and redeploy the matching build."
          : `File text extraction failed: ${message}`,
        {
          code: versionMismatch ? "PDFJS_VERSION_MISMATCH" : "FILE_EXTRACTION_FAILED",
          endpoint: input.url,
        },
      );
    }

    return {
      text,
      source: {
        url: input.url,
        filename: input.filename ?? null,
        contentType: contentType ?? null,
        bytes: buffer.byteLength,
      },
    };
  }

  async validate(): Promise<Record<string, unknown>> {
    const user = await this.requestJson("GET", "/users/me");
    return {
      ok: true,
      message: "Notion API reachable",
      user,
      notionVersion: this.notionVersion,
    };
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

  private async getAllBlockChildren(blockId: string, pageSize?: number): Promise<unknown[]> {
    const results: unknown[] = [];
    let startCursor: string | undefined;

    do {
      const response = await this.getBlocks({
        blockId,
        pageSize,
        startCursor,
      });
      if (Array.isArray(response.results)) {
        results.push(...response.results);
      }
      startCursor = typeof response.next_cursor === "string" ? response.next_cursor : undefined;
      if (response.has_more !== true) {
        startCursor = undefined;
      }
    } while (startCursor);

    return results;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(compact(query ?? {}))) {
      url.searchParams.set(key, String(value));
    }
    const requestBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Notion-Version": this.notionVersion,
            Accept: "application/json",
            ...(requestBody ? { "Content-Type": "application/json" } : {}),
          },
          body: requestBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const requestId = extractRequestId(response);

        if (response.status === 429) {
          if (attempt < 5) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
            continue;
          }
          throw new NotionRateLimitError("Notion rate limit exceeded", {
            endpoint: path,
            status: 429,
            requestId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          const responseBody = await this.readResponseBody(response);
          throw new NotionAuthError(`Notion authentication failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (response.status === 404) {
          const responseBody = await this.readResponseBody(response);
          throw new NotionNotFoundError(`Notion resource not found: ${path}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint: path,
            status: 404,
            requestId,
            responseBody,
          });
        }

        if (response.status === 400 || response.status === 409 || response.status === 422) {
          const responseBody = await this.readResponseBody(response);
          throw new NotionValidationError(`Notion request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (response.status >= 500) {
          if (attempt < 5) {
            await sleep(Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
            continue;
          }
          const responseBody = await this.readResponseBody(response);
          throw new NotionServerError(`Notion server error with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint: path,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (!response.ok) {
          const responseBody = await this.readResponseBody(response);
          throw new NotionError(`Notion request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
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
        if (error instanceof NotionError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new NotionConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new NotionRateLimitError("Notion rate limit exceeded", { endpoint: path, status: 429 });
  }

  private async readResponseBody(response: Response): Promise<string> {
    return (await response.text().catch(() => "")).slice(0, 500);
  }
}
