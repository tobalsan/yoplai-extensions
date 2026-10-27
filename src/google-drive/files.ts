import { open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { readConversationFile as readLocalConversationFile } from "../conversation-files.js";
import type { ToolExecutionContext } from "../tool-extension.js";

export type DriveRequest = (url: string, init?: RequestInit, expectedStatuses?: readonly number[]) => Promise<Response>;

/** Tool error with an HTTP status, so the gateway does not report it as a 500. */
class DriveFileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 413 | 502) { super(message); }
}
const OFFICE: Record<string, { extension: string; mimeType: string }> = {
  "application/vnd.google-apps.document": { extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "application/vnd.google-apps.spreadsheet": { extension: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "application/vnd.google-apps.presentation": { extension: "pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

function safeFilename(value: string): string {
  const cleaned = path.posix.basename(value.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f:*?"<>|]/g, "_").replace(/^\.+|[. ]+$/g, "") || "file";
  const extension = path.extname(cleaned).slice(0, 20);
  let stem = cleaned.slice(0, cleaned.length - extension.length);
  while (Buffer.byteLength(stem + extension) > 180) stem = Array.from(stem).slice(0, -1).join("");
  return stem + extension;
}

export async function downloadFile(fileId: string, context: ToolExecutionContext | undefined, request: DriveRequest, format: "office" | "pdf" = "office") {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to download Drive files.");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const folder = await realpath(context.conversationFiles.hostPath);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,capabilities(canDownload)");
  const metadata = await (await request(url.toString(), { signal })).json() as { name: string; mimeType: string; capabilities?: { canDownload?: boolean } };
  const native = OFFICE[metadata.mimeType];
  const office = native && format === "pdf" ? { extension: "pdf", mimeType: "application/pdf" } : native;
  if (format === "pdf" && !office) throw new DriveFileError("PDF export requires a native Google Doc, Sheet or Slides deck.", 400);
  if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !office) throw new DriveFileError(`Cannot download unsupported Google Drive type: ${metadata.mimeType}.`, 400);
  if (metadata.capabilities?.canDownload === false) throw new DriveFileError("Download is restricted by the file owner (canDownload=false).", 403);
  url.searchParams.delete("fields");
  if (office) {
    url.pathname += "/export";
    url.searchParams.delete("supportsAllDrives");
    url.searchParams.set("mimeType", office.mimeType);
  } else url.searchParams.set("alt", "media");
  const response = await request(url.toString(), { signal });
  const name = safeFilename(metadata.name + (office && !metadata.name.toLowerCase().endsWith(`.${office.extension}`) ? `.${office.extension}` : ""));
  const filename = `${crypto.randomUUID()}-${name}`;
  const destination = path.join(folder, filename);
  const file = await open(destination, "wx", 0o600);
  const reader = response.body?.getReader();
  const cancel = () => { if (reader) void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  try {
    signal.throwIfAborted();
    if (reader) for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > (office ? 10_000_000 : 25 * 1024 * 1024)) throw new DriveFileError(`Download exceeds the ${office ? "10 MB export" : "25 MiB media"} limit.`, 413);
      await file.writeFile(chunk.value);
    }
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {});
    await file.close();
    await rm(destination, { force: true });
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  await file.close();
  return { fileId, name, mimeType: office?.mimeType ?? metadata.mimeType, path: path.join(context.conversationFiles.runtimePath, filename), bytes };
}

export interface SaveFileParams { path: string; fileId?: string; name?: string; parentId?: string; convert?: boolean }

const BINARY_MIME: Record<string, string> = {
  docx: OFFICE["application/vnd.google-apps.document"].mimeType,
  xlsx: OFFICE["application/vnd.google-apps.spreadsheet"].mimeType,
  pptx: OFFICE["application/vnd.google-apps.presentation"].mimeType,
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", csv: "text/csv",
  json: "application/json", zip: "application/zip", doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
};

export { openConversationFile } from "../conversation-files.js";

export async function readConversationFile(sourcePath: string, context: ToolExecutionContext | undefined, signal: AbortSignal, maxBytes?: number) {
  const bytes = await readLocalConversationFile(sourcePath, context, signal, maxBytes);
  const mimeType = BINARY_MIME[path.extname(sourcePath).slice(1).toLowerCase()] ?? "application/octet-stream";
  return { bytes, mimeType };
}

export async function saveFile(params: SaveFileParams, context: ToolExecutionContext | undefined, request: DriveRequest) {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to save Drive files.");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  if (params.convert && params.fileId) throw new DriveFileError("convert cannot be used with fileId; create a new copy instead.", 400);
  if (params.convert && !/\.(docx|xlsx|pptx)$/i.test(params.path)) throw new DriveFileError("convert supports DOCX, XLSX and PPTX files only.", 400);
  if (!params.fileId && !params.name) throw new DriveFileError("Provide fileId to replace a file, or name to create a copy.", 400);
  if (params.fileId && (params.name || params.parentId)) throw new DriveFileError("Provide either fileId or name with optional parentId, not both.", 400);
  let { bytes, mimeType } = await readConversationFile(params.path, context, signal);
  const nativeMime = Object.entries(OFFICE).find(([, format]) => format.mimeType === mimeType)?.[0];
  let metadata: { name?: string; mimeType: string; parents?: string[] } = { name: params.name, mimeType, ...(params.parentId ? { parents: [params.parentId] } : {}) };
  if (params.convert) metadata.mimeType = nativeMime!;
  if (params.fileId) {
    const target = await (await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?supportsAllDrives=true&fields=id,name,mimeType`, { signal })).json() as { mimeType: string };
    const office = OFFICE[target.mimeType];
    if (target.mimeType.startsWith("application/vnd.google-apps.") && !office) throw new DriveFileError(`Unsupported replacement format: ${target.mimeType}.`, 400);
    if (office ? mimeType !== office.mimeType : mimeType !== "application/octet-stream" && mimeType !== target.mimeType) throw new DriveFileError("Local file format does not match the existing Drive file. Create a new copy instead.", 400);
    if (!office) mimeType = target.mimeType;
    metadata = { mimeType: target.mimeType };
  }
  const result = await uploadDriveFile(metadata, mimeType, bytes, request, signal, params.fileId);
  return { fileId: result.id, name: result.name, mimeType: result.mimeType, webViewLink: result.webViewLink ?? null };
}

export async function uploadDriveFile(metadata: { name?: string; mimeType: string; parents?: string[] }, mimeType: string, bytes: Buffer, request: DriveRequest, signal: AbortSignal, fileId?: string): Promise<{ id: string; name: string; mimeType: string; webViewLink?: string }> {
  if (bytes.length > 5_000_000) {
    const session = await request(`https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${encodeURIComponent(fileId)}` : ""}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,webViewLink`, {
      method: fileId ? "PATCH" : "POST", signal,
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(bytes.length) },
      body: JSON.stringify(metadata),
    }).catch(error => {
      signal.throwIfAborted();
      if (error instanceof TypeError && error.cause) throw uploadNetworkError(error, bytes.length, "session start");
      throw error;
    });
    const location = session.headers.get("location");
    if (!location) throw new Error("Google did not return a resumable upload location.");
    const endpoint = new URL(location);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "www.googleapis.com") throw new Error("Google returned an invalid resumable upload location.");
    let response: Response;
    try {
      response = await request(location, { method: "PUT", signal, headers: { "Content-Type": mimeType, "Content-Length": String(bytes.length) }, body: new Uint8Array(bytes) });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError && error.cause)) throw error;
      const status = await request(location, { method: "PUT", signal, headers: { "Content-Range": `bytes */${bytes.length}`, "Content-Length": "0" }, body: new Uint8Array(0) }, [308]).catch(error => {
        signal.throwIfAborted();
        throw uploadFailure(error, bytes.length, "status query");
      });
      if (status.status === 200 || status.status === 201) response = status;
      else {
        if (status.status !== 308) throw uploadFailure(new Error(`Unexpected HTTP ${status.status}`), bytes.length, "status query");
        const range = status.headers.get("Range");
        const start = range ? Number(range.match(/^bytes=0-(\d+)$/)?.[1]) + 1 : 0;
        if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length) throw uploadFailure(new Error(`Invalid acknowledged range: ${range}`), bytes.length, "status query");
        response = await request(location, { method: "PUT", signal, headers: { "Content-Type": mimeType, "Content-Length": String(bytes.length - start), "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` }, body: new Uint8Array(bytes.subarray(start)) }).catch(error => {
          signal.throwIfAborted();
          if (error instanceof TypeError && error.cause) throw uploadNetworkError(error, bytes.length, "resume PUT");
          throw error;
        });
      }
    }
    return await response.json() as { id: string; name: string; mimeType: string; webViewLink?: string };
  }
  const boundary = `yoplai-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request(`https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${encodeURIComponent(fileId)}` : ""}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink`, {
    method: fileId ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body, signal,
  }).catch(error => {
    signal.throwIfAborted();
    if (error instanceof TypeError && error.cause) throw uploadNetworkError(error, bytes.length, "multipart upload");
    throw error;
  });
  const result = await response.json() as { id: string; name: string; mimeType: string; webViewLink?: string };
  return result;
}

function uploadNetworkError(error: TypeError, size: number, stage: string): DriveFileError {
  const cause = error.cause as { code?: string; message?: string };
  return new DriveFileError(`Google Drive ${stage} failed for ${size} bytes: ${cause.code ?? "unknown code"}: ${cause.message ?? String(error.cause)}`, 502);
}

function uploadFailure(error: unknown, size: number, stage: string): DriveFileError {
  if (error instanceof TypeError && error.cause) return uploadNetworkError(error, size, stage);
  return new DriveFileError(`Google Drive ${stage} failed for ${size} bytes: ${error instanceof Error ? error.message : String(error)}`, 502);
}
