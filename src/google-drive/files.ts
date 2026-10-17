import { open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ToolExecutionContext } from "../tool-extension.js";

export type DriveRequest = (url: string, init?: RequestInit) => Promise<Response>;
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

export async function downloadFile(fileId: string, context: ToolExecutionContext | undefined, request: DriveRequest) {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to download Drive files.");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const folder = await realpath(context.conversationFiles.hostPath);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,capabilities(canDownload)");
  const metadata = await (await request(url.toString(), { signal })).json() as { name: string; mimeType: string; capabilities?: { canDownload?: boolean } };
  const office = OFFICE[metadata.mimeType];
  if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !office) throw new Error(`Cannot download unsupported Google Drive type: ${metadata.mimeType}.`);
  if (metadata.capabilities?.canDownload === false) throw new Error("Download is restricted by the file owner (canDownload=false).");
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
      if (bytes > (office ? 10_000_000 : 25 * 1024 * 1024)) throw new Error(`Download exceeds the ${office ? "10 MB export" : "25 MiB media"} limit.`);
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

export interface SaveFileParams { path: string; fileId?: string; name?: string; parentId?: string }

const BINARY_MIME: Record<string, string> = {
  docx: OFFICE["application/vnd.google-apps.document"].mimeType,
  xlsx: OFFICE["application/vnd.google-apps.spreadsheet"].mimeType,
  pptx: OFFICE["application/vnd.google-apps.presentation"].mimeType,
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", csv: "text/csv",
  json: "application/json", zip: "application/zip", doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
};

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function saveFile(params: SaveFileParams, context: ToolExecutionContext | undefined, request: DriveRequest) {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to save Drive files.");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  if (!params.fileId && !params.name) throw new Error("Provide fileId to replace a file, or name to create a copy.");
  if (params.fileId && (params.name || params.parentId)) throw new Error("Provide either fileId or name with optional parentId, not both.");
  const folder = await realpath(context.conversationFiles.hostPath);
  const { hostPath, runtimePath } = context.conversationFiles;
  if (!path.isAbsolute(params.path)) throw new Error("Only files inside the current conversation folder may be saved.");
  let local: string;
  if (inside(runtimePath, params.path)) local = path.resolve(folder, path.relative(runtimePath, params.path));
  else if (inside(hostPath, params.path)) local = path.resolve(folder, path.relative(hostPath, params.path));
  else if (inside(folder, params.path)) local = path.resolve(params.path);
  else throw new Error("File path is outside the current conversation folder.");
  if (path.dirname(local) !== folder) throw new Error("Save files directly in the conversation folder root; nested paths are not supported.");
  local = await realpath(local);
  if (!inside(folder, local)) throw new Error("File path is outside the current conversation folder.");
  if (path.dirname(local) !== folder) throw new Error("Save files directly in the conversation folder root; nested paths are not supported.");
  const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!(await file.stat()).isFile()) throw new Error("Only regular files inside the current conversation folder may be saved.");
    bytes = await file.readFile({ signal });
  } finally { await file.close(); }
  let mimeType = BINARY_MIME[path.extname(params.path).slice(1).toLowerCase()] ?? "application/octet-stream";
  let metadata: { name?: string; mimeType: string; parents?: string[] } = { name: params.name, mimeType, ...(params.parentId ? { parents: [params.parentId] } : {}) };
  if (params.fileId) {
    const target = await (await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?supportsAllDrives=true&fields=id,name,mimeType`, { signal })).json() as { mimeType: string };
    const office = OFFICE[target.mimeType];
    if (target.mimeType.startsWith("application/vnd.google-apps.") && !office) throw new Error(`Unsupported replacement format: ${target.mimeType}.`);
    if (office ? mimeType !== office.mimeType : mimeType !== "application/octet-stream" && mimeType !== target.mimeType) throw new Error("Local file format does not match the existing Drive file. Create a new copy instead.");
    if (!office) mimeType = target.mimeType;
    metadata = { mimeType: target.mimeType };
  }
  const boundary = `yoplai-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request(`https://www.googleapis.com/upload/drive/v3/files${params.fileId ? `/${encodeURIComponent(params.fileId)}` : ""}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink`, {
    method: params.fileId ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body, signal,
  });
  const result = await response.json() as { id: string; name: string; mimeType: string; webViewLink?: string };
  return { fileId: result.id, name: result.name, mimeType: result.mimeType, webViewLink: result.webViewLink ?? null };
}
