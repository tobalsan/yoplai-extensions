import mammoth from "mammoth";

import {
  DRIVE_ABOUT_URL,
  DRIVE_FILES_URL,
  DRIVE_FILE_FIELDS,
  GOOGLE_WORKSPACE_EXPORT_MIME,
  driveFileExportUrl,
  driveFileMediaUrl,
  type ListFilesParams,
  type ReadFileParams,
  type SearchFilesParams,
} from "./models.js";

export type DriveFetch = typeof fetch;

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

/**
 * Read-only Google Drive client. It consumes the fresh access token injected by
 * the host OAuth resolver and exposes list/search/read-file capabilities plus
 * the `about` probe used by `validate`. No write scopes, no mutating calls.
 */
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

  async #request(url: string): Promise<Response> {
    const response = await this.#fetch(url, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Google Drive request failed (HTTP ${response.status})${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    return response;
  }
}
