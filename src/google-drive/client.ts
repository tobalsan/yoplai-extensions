import mammoth from "mammoth";

import {
  DRIVE_ABOUT_URL,
  DRIVE_FILES_URL,
  DRIVE_FILE_FIELDS,
  GOOGLE_WORKSPACE_EXPORT_MIME,
  driveFileExportUrl,
  driveFileMediaUrl,
  type CreateFolderParams,
  type CreateFileParams,
  type UpdateFileContentParams,
  type RenameMoveFileParams,
  type SheetsUpdateRangeParams,
  type SheetsAppendRowsParams,
  type ListFilesParams,
  type ReadFileParams,
  type SearchFilesParams,
} from "./models.js";

export type DriveFetch = typeof fetch;

export class GoogleDriveRequestError extends Error {
  constructor(message: string, readonly status: number, readonly endpoint: string, readonly responseBody: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string | null;
  modifiedTime: string | null;
  size: number | null;
  webViewLink: string | null;
}

interface DriveFilesListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
  }>;
  nextPageToken?: string;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function looksLikePdf(name: string, mimeType?: string | null): boolean {
  const hint = `${name} ${mimeType ?? ""}`.toLowerCase();
  return hint.includes("pdf") || hint.includes("application/pdf");
}

function looksLikeDocx(name: string, mimeType?: string | null): boolean {
  const hint = `${name} ${mimeType ?? ""}`.toLowerCase();
  return (
    hint.includes(".docx") ||
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

export class GoogleDriveClient {
  #accessToken: string;
  #fetch: DriveFetch;

  constructor(accessToken: string, fetchImpl: DriveFetch = fetch) {
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
  }

  async about(): Promise<DriveUser> {
    const response = await this.#request(DRIVE_ABOUT_URL);
    const data = (await response.json().catch(() => ({}))) as { user?: DriveUser };
    return data.user ?? {};
  }

  async listFiles(params: ListFilesParams): Promise<{
    files: DriveFile[];
    nextPageToken: string | null;
  }> {
    const filters = ["trashed=false"];
    if (params.query?.trim()) {
      filters.push(`name contains '${escapeDriveQueryValue(params.query.trim())}'`);
    }
    return this.#queryFiles(filters.join(" and "), params.pageSize, params.pageToken);
  }

  async searchFiles(params: SearchFilesParams): Promise<{
    files: DriveFile[];
    nextPageToken: string | null;
  }> {
    return this.#queryFiles(params.query.trim(), params.pageSize, params.pageToken);
  }

  async readFile(params: ReadFileParams): Promise<{
    fileId: string;
    name: string;
    mimeType: string | null;
    text: string;
    bytes: number;
    exported: boolean;
  }> {
    const metadata = await this.#getFileMetadata(params.fileId);
    const exportMime = metadata.mimeType
      ? GOOGLE_WORKSPACE_EXPORT_MIME[metadata.mimeType]
      : undefined;

    const url = exportMime
      ? driveFileExportUrl(params.fileId, exportMime)
      : driveFileMediaUrl(params.fileId);
    const response = await this.#request(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const effectiveMime = exportMime ?? metadata.mimeType ?? null;
    const text = await this.#extractText(buffer, metadata.name, effectiveMime);

    return {
      fileId: params.fileId,
      name: metadata.name,
      mimeType: metadata.mimeType,
      text,
      bytes: buffer.byteLength,
      exported: Boolean(exportMime),
    };
  }

  async createFolder(params: CreateFolderParams): Promise<unknown> {
    return this.#json(DRIVE_FILES_URL, "POST", {
      name: params.name,
      mimeType: "application/vnd.google-apps.folder",
      ...(params.parentId ? { parents: [params.parentId] } : {}),
    });
  }

  async createFile(params: CreateFileParams): Promise<unknown> {
    const mimeType = params.mimeType ?? (params.convertTo === "sheet" ? "text/csv" : "text/plain");
    const metadata = {
      name: params.name,
      mimeType: params.convertTo === "doc" ? "application/vnd.google-apps.document"
        : params.convertTo === "sheet" ? "application/vnd.google-apps.spreadsheet" : mimeType,
      ...(params.parentId ? { parents: [params.parentId] } : {}),
    };
    const boundary = `yoplai-${crypto.randomUUID()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${params.content}\r\n--${boundary}--\r\n`;
    const response = await this.#request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    });
    return response.json();
  }

  async updateFileContent(params: UpdateFileContentParams): Promise<unknown> {
    const metadata = await this.#getFileMetadata(params.fileId);
    const mimeType = metadata.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv"
      : metadata.mimeType === "application/vnd.google-apps.document" ? "text/plain"
      : metadata.mimeType ?? "text/plain";
    const response = await this.#request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.fileId)}?uploadType=media`, {
      method: "PATCH", headers: { "Content-Type": mimeType }, body: params.content,
    });
    return response.json();
  }

  async renameMoveFile(params: RenameMoveFileParams): Promise<unknown> {
    if (!params.name && !params.addParentId && !params.removeParentId) {
      throw new Error("Provide a name or parent change.");
    }
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}`);
    if (params.addParentId) url.searchParams.set("addParents", params.addParentId);
    if (params.removeParentId) url.searchParams.set("removeParents", params.removeParentId);
    return this.#json(url.toString(), "PATCH", params.name ? { name: params.name } : {});
  }

  async sheetsUpdateRange(params: SheetsUpdateRangeParams): Promise<unknown> {
    return this.#sheetValues(params.spreadsheetId, params.range, params.values, false);
  }

  async sheetsAppendRows(params: SheetsAppendRowsParams): Promise<unknown> {
    return this.#sheetValues(params.spreadsheetId, params.range, params.rows, true);
  }

  async #sheetValues(spreadsheetId: string, range: string, values: (string | number | boolean)[][], append: boolean): Promise<unknown> {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${append ? ":append" : ""}`);
    url.searchParams.set("valueInputOption", "USER_ENTERED");
    if (append) url.searchParams.set("insertDataOption", "INSERT_ROWS");
    return this.#json(url.toString(), append ? "POST" : "PUT", { range, majorDimension: "ROWS", values });
  }

  async #json(url: string, method: string, body: unknown): Promise<unknown> {
    const response = await this.#request(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return response.json();
  }

  async #queryFiles(
    q: string,
    pageSize: number,
    pageToken?: string,
  ): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("fields", DRIVE_FILE_FIELDS);
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("spaces", "drive");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await this.#request(url.toString());
    const data = (await response.json().catch(() => ({}))) as DriveFilesListResponse;
    const files = (data.files ?? []).map((file) => ({
      id: file.id ?? "",
      name: file.name ?? "",
      mimeType: file.mimeType ?? null,
      modifiedTime: file.modifiedTime ?? null,
      size: file.size !== undefined ? Number(file.size) : null,
      webViewLink: file.webViewLink ?? null,
    }));
    return { files, nextPageToken: data.nextPageToken ?? null };
  }

  async #getFileMetadata(fileId: string): Promise<{
    id: string;
    name: string;
    mimeType: string | null;
  }> {
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", "id,name,mimeType");
    const response = await this.#request(url.toString());
    const data = (await response.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      mimeType?: string;
    };
    return {
      id: data.id ?? fileId,
      name: data.name ?? "",
      mimeType: data.mimeType ?? null,
    };
  }

  async #extractText(buffer: Buffer, name: string, mimeType: string | null): Promise<string> {
    if (looksLikePdf(name, mimeType)) {
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

    if (looksLikeDocx(name, mimeType)) {
      const result = await mammoth.extractRawText({ buffer });
      return normalizeText(result.value);
    }

    return normalizeText(buffer.toString("utf8"));
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          Accept: "application/json",
          ...init.headers,
        },
      });
      if (response.status === 429 && attempt < 2) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const delay = Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1000)) : 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const responseBody = body.slice(0, 500);
        throw new GoogleDriveRequestError(
          `Google Drive request failed (HTTP ${response.status}) for ${url}${responseBody ? `: ${responseBody}` : ""}`,
          response.status, url, responseBody,
        );
      }
      return response;
    }
  }
}
