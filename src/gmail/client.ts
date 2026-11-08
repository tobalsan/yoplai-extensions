import { open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { BINARY_MIME, readConversationFile, safeFilename } from "../conversation-files.js";
import type { ToolExecutionContext } from "../tool-extension.js";
import {
  type CreateDraftParams,
  type DownloadAttachmentParams,
  type CreateLabelParams,
  type GetThreadParams,
  GMAIL_API_BASE,
  type LabelMessageParams,
  type LabelThreadParams,
  type ListDraftsParams,
  type SearchThreadsParams,
  type SendEmailParams,
  type SendDraftParams,
  type UpdateDraftParams,
} from "./models.js";

export type GmailFetch = typeof fetch;

type GmailHeader = { name?: string; value?: string };
type GmailPart = { partId?: string; mimeType?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GmailPart[]; filename?: string };
type GmailMessage = { id?: string; threadId?: string; snippet?: string; payload?: GmailPart & { headers?: GmailHeader[] }; internalDate?: string };

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function decode(data: string | undefined): string {
  return data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
}
function partOf(part: GmailPart | undefined, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) return decode(part.body.data);
  return (part.parts ?? []).map((child) => partOf(child, mimeType)).find(Boolean) ?? "";
}
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isNaN(n) ? match : String.fromCodePoint(n);
    })
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** Plain-text body; falls back to the text/html part (converted to text) for HTML-only mail. */
function body(part: GmailPart | undefined): string {
  const plain = partOf(part, "text/plain");
  if (plain.trim()) return plain;
  const html = partOf(part, "text/html");
  return html ? htmlToText(html) : plain;
}
function attachments(part: GmailPart | undefined): string[] {
  if (!part) return [];
  return [part.body?.attachmentId, ...(part.parts ?? []).flatMap(attachments)].filter((value): value is string => Boolean(value));
}
function attachmentParts(part: GmailPart | undefined, includeInline = false): GmailPart[] {
  if (!part) return [];
  return [...(part.filename && (part.body?.attachmentId || (includeInline && part.body?.data !== undefined)) ? [part] : []), ...(part.parts ?? []).flatMap((child) => attachmentParts(child, includeInline))];
}
function attachmentMetadata(message: GmailMessage) {
  return attachmentParts(message.payload).map((part) => ({ messageId: message.id ?? "", attachmentId: part.body!.attachmentId!, partId: part.partId ?? "", filename: part.filename!, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 }));
}
function date(message: GmailMessage): string {
  const value = header(message, "Date");
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}
function recipients(message: GmailMessage, name: string): string[] {
  const value = header(message, name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}
function asMessage(message: GmailMessage, full: boolean) {
  return {
    id: message.id ?? "",
    snippet: message.snippet ?? "",
    subject: header(message, "Subject"),
    sender: header(message, "From"),
    toRecipients: recipients(message, "To"),
    ccRecipients: recipients(message, "Cc"),
    date: date(message),
    attachments: attachmentMetadata(message),
    ...(full ? { plaintextBody: body(message.payload), attachmentIds: attachments(message.payload) } : {}),
  };
}
type OutgoingAttachment = { filename: string; mimeType: string; bytes: Buffer };
// download_attachment saves files as `<uuid>-<name>`; the recipient sees `<name>`.
const DOWNLOAD_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?=.)/i;
export const MAX_MIME_BYTES = 36_700_160;
const MAX_ATTACHMENT_BYTES = 25_000_000;
function encodedHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new GmailFileError("Headers must not contain line breaks.", 400);
  if (!/[^\x20-\x7e]/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    // 39 UTF-8 bytes keep encoded words and their Subject prefix below 76 columns.
    if (Buffer.byteLength(chunk + char) > 39) { chunks.push(chunk); chunk = ""; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}
function base64(bytes: Buffer): string { return bytes.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""; }
function textPart(text: string, mimeType: string): string {
  const encoded = /[^\x00-\x7f]/.test(text);
  return [`Content-Type: ${mimeType}; charset=UTF-8`, ...(encoded ? ["Content-Transfer-Encoding: base64"] : []), "", encoded ? base64(Buffer.from(text)) : text].join("\r\n");
}
function multipart(parts: string[], subtype: string): string {
  const boundary = `yoplai-${crypto.randomUUID()}`;
  return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", ...parts.map((part) => `--${boundary}\r\n${part}`), `--${boundary}--`].join("\r\n");
}
function rawMessage(params: CreateDraftParams, replyMessageId?: string, files: OutgoingAttachment[] = []): string {
  const headers = [
    `To: ${params.to.join(", ")}`,
    ...(params.cc?.length ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    `Subject: ${encodedHeader(params.subject ?? "")}`,
    ...(replyMessageId ? [`In-Reply-To: ${replyMessageId}`, `References: ${replyMessageId}`] : []),
    "MIME-Version: 1.0",
  ];
  let content = params.htmlBody !== undefined ? multipart([textPart(params.body ?? "", "text/plain"), textPart(params.htmlBody, "text/html")], "alternative") : textPart(params.body ?? "", "text/plain");
  if (files.length) content = multipart([content, ...files.map((file) => {
    encodedHeader(file.filename);
    const fallback = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(file.filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return [`Content-Type: ${file.mimeType}`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`, "", base64(file.bytes)].join("\r\n");
  })], "mixed");
  const mime = [...headers, content].join("\r\n");
  if (Buffer.byteLength(mime) > MAX_MIME_BYTES) throw new GmailFileError(`Message exceeds the ${MAX_MIME_BYTES} byte MIME limit.`, 413);
  return mime;
}

export class GmailClient {
  constructor(private readonly accessToken: string, private readonly fetchImpl: GmailFetch = fetch) {}

  async downloadAttachment(params: DownloadAttachmentParams, context?: ToolExecutionContext) {
    if (!context?.conversationFiles) throw new Error("A conversation files folder is required to download Gmail attachments.");
    const signal = executionSignal(context);
    const message = await this.request(`/messages/${encodeURIComponent(params.messageId)}?format=full`, { signal }) as GmailMessage;
    // Attachment IDs can change between Gmail reads; partId identifies the MIME part.
    const matches = attachmentParts(message.payload).filter((part) => {
      if (params.partId !== undefined) return part.partId === params.partId;
      if (params.filename !== undefined || params.size !== undefined) return params.filename !== undefined && params.size !== undefined && part.filename === params.filename && part.body?.size === params.size;
      return part.body?.attachmentId === params.attachmentId;
    });
    if (matches.length > 1) throw new GmailFileError("Multiple attachments match; pass partId from get_thread.", 400);
    const part = matches[0];
    if (!part) throw new GmailFileError("Attachment not found on message. Pass partId or filename and size from get_thread.", 404);
    if ((part.body?.size ?? 0) > 25 * 1024 * 1024) throw new GmailFileError("Attachment exceeds the 25 MiB download limit.", 413);
    const data = await this.request(`/messages/${encodeURIComponent(params.messageId)}/attachments/${encodeURIComponent(params.attachmentId)}`, { signal }, Math.ceil(25 * 1024 * 1024 * 4 / 3) + 1024) as { data?: string };
    if (typeof data.data !== "string") throw new GmailFileError("Gmail returned no attachment data.", 502);
    const bytes = Buffer.from(data.data, "base64url");
    if (bytes.length > 25 * 1024 * 1024) throw new GmailFileError("Attachment exceeds the 25 MiB download limit.", 413);
    const folder = await realpath(context.conversationFiles.hostPath);
    const filename = `${crypto.randomUUID()}-${safeFilename(part.filename!)}`;
    const destination = path.join(folder, filename);
    const file = await open(destination, "wx", 0o600);
    try { signal.throwIfAborted(); await file.writeFile(bytes, { signal }); }
    catch (error) { await file.close(); await rm(destination, { force: true }); throw error; }
    await file.close();
    return { path: path.join(context.conversationFiles.runtimePath, filename), name: part.filename!, mimeType: part.mimeType ?? "application/octet-stream", bytes: bytes.length };
  }
  async sendEmail(params: SendEmailParams, context?: ToolExecutionContext) {
    if (!params.body?.trim() && !params.htmlBody?.trim()) throw new GmailFileError("A nonempty body or htmlBody is required to send email.", 400);
    const signal = executionSignal(context);
    const files = await this.localAttachments(params.attachments, context, signal);
    const reply = params.replyToMessageId ? await this.request(`/messages/${encodeURIComponent(params.replyToMessageId)}?format=metadata`, { signal }) as GmailMessage : undefined;
    const mime = rawMessage(params, reply ? header(reply, "Message-ID") : undefined, files);
    const data = await this.uploadMessage("/messages/send", "POST", mime, signal, reply?.threadId ? { threadId: reply.threadId } : undefined) as GmailMessage;
    if (!data.id) throw new GmailFileError("Gmail did not return a sent message ID.", 502);
    return { messageId: data.id, threadId: data.threadId ?? "" };
  }
  async sendDraft(params: SendDraftParams, context?: ToolExecutionContext) {
    const signal = executionSignal(context);
    const data = await this.request("/drafts/send", { method: "POST", signal, body: JSON.stringify({ id: params.draftId }) }) as GmailMessage;
    if (!data.id) throw new GmailFileError("Gmail did not return a sent message ID.", 502);
    return { messageId: data.id, threadId: data.threadId ?? "" };
  }
  async createDraft(params: CreateDraftParams, context?: ToolExecutionContext) {
    const signal = executionSignal(context);
    const files = await this.localAttachments(params.attachments, context, signal);
    const reply = params.replyToMessageId
      ? await this.request(`/messages/${encodeURIComponent(params.replyToMessageId)}?format=metadata`, { signal }) as GmailMessage
      : undefined;
    const mime = rawMessage(params, reply ? header(reply, "Message-ID") : undefined, files);
    const data = await this.uploadMessage("/drafts", "POST", mime, signal, reply?.threadId ? { message: { threadId: reply.threadId } } : undefined) as { id?: string };
    return this.getDraft(data.id ?? "", signal);
  }
  async updateDraft(params: UpdateDraftParams, context?: ToolExecutionContext) {
    const signal = executionSignal(context);
    // Gmail replaces the whole draft; omitted fields keep current values (HTML body is not preserved unless resent).
    const id = encodeURIComponent(params.draftId);
    const existing = (await this.request(`/drafts/${id}?format=full`, { signal }) as { message?: GmailMessage }).message ?? {};
    const files = params.attachments === undefined ? await this.existingAttachments(existing, signal) : await this.localAttachments(params.attachments, context, signal);
    const merged: CreateDraftParams = {
      to: params.to ?? recipients(existing, "To"),
      cc: params.cc ?? recipients(existing, "Cc"),
      bcc: params.bcc ?? recipients(existing, "Bcc"),
      subject: params.subject ?? header(existing, "Subject"),
      body: params.body ?? body(existing.payload),
      htmlBody: params.htmlBody,
    };
    const mime = rawMessage(merged, header(existing, "In-Reply-To") || undefined, files);
    await this.uploadMessage(`/drafts/${id}`, "PUT", mime, signal, existing.threadId ? { message: { threadId: existing.threadId } } : undefined);
    return this.getDraft(params.draftId, signal);
  }
  async deleteDraft(params: { draftId: string }) {
    await this.request(`/drafts/${encodeURIComponent(params.draftId)}`, { method: "DELETE" });
    return { deleted: true, draftId: params.draftId };
  }
  async account(context?: ToolExecutionContext) {
    const profile = await this.request("/profile", { signal: executionSignal(context) }) as { emailAddress?: string };
    return profile.emailAddress ?? "";
  }
  async listDrafts(params: ListDraftsParams) {
    const query = new URLSearchParams({ maxResults: String(params.pageSize), ...(params.query ? { q: params.query } : {}), ...(params.pageToken ? { pageToken: params.pageToken } : {}) });
    const data = await this.request(`/drafts?${query}`) as { drafts?: Array<{ id?: string }>; nextPageToken?: string };
    const drafts = await mapLimited(data.drafts ?? [], (item) => this.getDraft(item.id ?? ""));
    return { drafts, nextPageToken: data.nextPageToken ?? null };
  }
  async getThread(params: GetThreadParams) {
    const data = await this.request(`/threads/${encodeURIComponent(params.threadId)}?format=full`) as { id?: string; messages?: GmailMessage[] };
    const full = params.messageFormat !== "MINIMAL";
    return { id: data.id ?? params.threadId, messages: (data.messages ?? []).map((message) => asMessage(message, full)) };
  }
  async searchThreads(params: SearchThreadsParams) {
    const query = new URLSearchParams({ maxResults: String(params.pageSize), ...(params.query ? { q: params.query } : {}), ...(params.pageToken ? { pageToken: params.pageToken } : {}), ...(params.includeTrash ? { includeSpamTrash: "true" } : {}) });
    const data = await this.request(`/threads?${query}`) as { threads?: Array<{ id?: string }>; nextPageToken?: string };
    const threads = await mapLimited(data.threads ?? [], (item) => this.getThread({ threadId: item.id ?? "", messageFormat: "MINIMAL" }));
    return { threads, nextPageToken: data.nextPageToken ?? null };
  }
  async labelThread(params: LabelThreadParams, remove = false) { await this.modify(`/threads/${encodeURIComponent(params.threadId)}/modify`, params.labelIds, remove); return {}; }
  async labelMessage(params: LabelMessageParams, remove = false) { await this.modify(`/messages/${encodeURIComponent(params.messageId)}/modify`, params.labelIds, remove); return {}; }
  async listLabels(params: { pageSize: number; pageToken?: string }) {
    const data = await this.request("/labels") as { labels?: Array<{ id?: string; name?: string; type?: string; color?: { textColor?: string; backgroundColor?: string }; threadsTotal?: number; threadsUnread?: number }> };
    const offset = params.pageToken ? Number.parseInt(params.pageToken, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Gmail labels page token");
    const labels = (data.labels ?? []).filter((label) => label.type === "user").map((label) => ({ labelId: label.id ?? "", name: label.name ?? "", ...(label.color?.textColor && label.color.backgroundColor ? { color: label.color } : {}), threadsTotal: label.threadsTotal ?? 0, threadsUnread: label.threadsUnread ?? 0 }));
    const page = labels.slice(offset, offset + params.pageSize);
    return { labels: page, nextPageToken: offset + page.length < labels.length ? String(offset + page.length) : null };
  }
  async createLabel(params: CreateLabelParams) {
    const data = await this.request("/labels", { method: "POST", body: JSON.stringify({ name: params.displayName, ...(params.color ? { color: params.color } : {}) }) }) as { id?: string; name?: string; color?: { textColor?: string; backgroundColor?: string }; threadsTotal?: number; threadsUnread?: number };
    return { labelId: data.id ?? "", name: data.name ?? params.displayName, ...(data.color?.textColor && data.color.backgroundColor ? { color: data.color } : {}), threadsTotal: data.threadsTotal ?? 0, threadsUnread: data.threadsUnread ?? 0 };
  }
  private async existingAttachments(message: GmailMessage, signal: AbortSignal): Promise<OutgoingAttachment[]> {
    const files: OutgoingAttachment[] = [];
    let remaining = MAX_ATTACHMENT_BYTES;
    const parts = attachmentParts(message.payload, true);
    if (parts.length > 10) throw new GmailFileError("At most 10 attachments are supported.", 413);
    for (const part of parts) {
      if ((part.body?.size ?? 0) > remaining) throw new GmailFileError("Draft attachments exceed the outgoing message limit.", 413);
      const data = part.body?.attachmentId ? await this.request(`/messages/${encodeURIComponent(message.id ?? "")}/attachments/${encodeURIComponent(part.body.attachmentId)}`, { signal }, Math.ceil(remaining * 4 / 3) + 1024) as { data?: string } : part.body!;
      if (typeof data.data !== "string") throw new GmailFileError("Gmail returned no attachment data.", 502);
      const bytes = Buffer.from(data.data, "base64url");
      if (bytes.length > remaining) throw new GmailFileError("Draft attachments exceed the outgoing message limit.", 413);
      remaining -= bytes.length;
      files.push({ filename: part.filename!, mimeType: part.mimeType ?? "application/octet-stream", bytes });
    }
    return files;
  }
  private async localAttachments(attachments: CreateDraftParams["attachments"], context: ToolExecutionContext | undefined, signal: AbortSignal): Promise<OutgoingAttachment[]> {
    const files: OutgoingAttachment[] = [];
    let remaining = MAX_ATTACHMENT_BYTES;
    if ((attachments?.length ?? 0) > 10) throw new GmailFileError("At most 10 attachments are supported.", 413);
    for (const attachment of attachments ?? []) {
      const bytes = await readConversationFile(attachment.path, context, signal, remaining);
      remaining -= bytes.length;
      const extension = path.extname(attachment.path).slice(1).toLowerCase();
      files.push({ filename: path.basename(attachment.path).replace(DOWNLOAD_PREFIX, ""), mimeType: Object.hasOwn(BINARY_MIME, extension) ? BINARY_MIME[extension] : "application/octet-stream", bytes });
    }
    return files;
  }
  private async getDraft(id: string, signal?: AbortSignal) { const data = await this.request(`/drafts/${encodeURIComponent(id)}?format=full`, { signal }) as { id?: string; message?: GmailMessage }; return this.draft(data.id ?? id, data.message ?? {}); }
  private draft(id: string, message: GmailMessage) { return { id, subject: header(message, "Subject"), threadId: message.threadId ?? "", toRecipients: recipients(message, "To"), ccRecipients: recipients(message, "Cc"), bccRecipients: recipients(message, "Bcc"), plaintextBody: body(message.payload), date: date(message), attachments: attachmentParts(message.payload, true).map((part) => ({ filename: part.filename!, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 })) }; }
  private async modify(path: string, labelIds: string[], remove: boolean) { await this.request(path, { method: "POST", body: JSON.stringify(remove ? { removeLabelIds: labelIds } : { addLabelIds: labelIds }) }); }
  private async uploadMessage(path: string, method: string, mime: string, signal: AbortSignal, metadata?: object) {
    const boundary = `yoplai-upload-${crypto.randomUUID()}`;
    const body = metadata ? [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify(metadata), `--${boundary}`, "Content-Type: message/rfc822", "", mime, `--${boundary}--`, ""].join("\r\n") : mime;
    return this.request(`${path}?uploadType=${metadata ? "multipart" : "media"}`, { method, signal, body, headers: { "Content-Type": metadata ? `multipart/related; boundary="${boundary}"` : "message/rfc822" } }, undefined, "https://gmail.googleapis.com/upload/gmail/v1/users/me");
  }
  private async request(path: string, init: RequestInit = {}, maxResponseBytes?: number, base = GMAIL_API_BASE) {
    const options = { ...init, headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...Object.fromEntries(new Headers(init.headers)) } };
    const send = () => this.fetchImpl(`${base}${path}`, options);
    let response: Response;
    try { response = await send(); }
    catch (error) {
      // Retry a read once when fetch got no HTTP response (undici `TypeError: fetch failed`); aborts and writes are never retried.
      if ((init.method ?? "GET") !== "GET" || !(error instanceof TypeError) || error.message !== "fetch failed" || init.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
      try { response = await send(); } catch { throw error; }
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const responseBody = body.slice(0, 500);
      let payload: { error?: { status?: string; errors?: Array<{ reason?: string }> } } | undefined;
      try { payload = JSON.parse(body || "{}") as typeof payload; } catch { payload = undefined; }
      throw new GmailRequestError(
        response.status,
        path,
        init.method ?? "GET",
        responseBody,
        payload?.error?.status ?? payload?.error?.errors?.[0]?.reason,
      );
    }
    if (maxResponseBytes !== undefined || init.signal) {
      const reader = response.body?.getReader();
      const cancel = () => { if (reader) void reader.cancel(init.signal?.reason).catch(() => {}); };
      init.signal?.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (reader) for (;;) {
          init.signal?.throwIfAborted();
          const chunk = await reader.read();
          init.signal?.throwIfAborted();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (maxResponseBytes !== undefined && length > maxResponseBytes) throw new GmailFileError("Attachment response exceeds the permitted byte limit.", 413);
          chunks.push(chunk.value);
        }
        init.signal?.throwIfAborted();
        const text = Buffer.concat(chunks).toString("utf8");
        if (maxResponseBytes !== undefined) return JSON.parse(text) as unknown;
        try { return JSON.parse(text) as unknown; } catch { return {}; }
      } catch (error) { if (reader) void reader.cancel().catch(() => {}); throw error; }
      finally { init.signal?.removeEventListener("abort", cancel); }
    }
    return response.json().catch(() => ({}));
  }
}

export class GmailRequestError extends Error {
  constructor(readonly status: number, readonly endpoint: string, readonly method: string, readonly responseBody: string, readonly reason?: string) {
    super(`Gmail request failed (HTTP ${status}) ${method} ${endpoint}${responseBody ? `: ${responseBody}` : ""}`);
  }
}

/** Like Promise.all over `items.map(task)`, with at most `limit` tasks in flight (Gmail per-user burst). */
async function mapLimited<T, R>(items: T[], task: (item: T) => Promise<R>, limit = 5): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await task(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function executionSignal(context?: ToolExecutionContext) { return context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000); }

class GmailFileError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 | 502) { super(message); }
}
