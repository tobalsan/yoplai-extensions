import {
  type CreateDraftParams,
  type CreateLabelParams,
  type GetThreadParams,
  GMAIL_API_BASE,
  type LabelMessageParams,
  type LabelThreadParams,
  type ListDraftsParams,
  type SearchThreadsParams,
  type UpdateDraftParams,
} from "./models.js";

export type GmailFetch = typeof fetch;

type GmailHeader = { name?: string; value?: string };
type GmailPart = { mimeType?: string; body?: { data?: string; attachmentId?: string }; parts?: GmailPart[]; filename?: string };
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
    ...(full ? { plaintextBody: body(message.payload), attachmentIds: attachments(message.payload) } : {}),
  };
}
function rawMessage(params: CreateDraftParams, replyMessageId?: string): string {
  const headers = [
    `To: ${params.to.join(", ")}`,
    ...(params.cc?.length ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    `Subject: ${params.subject ?? ""}`,
    ...(replyMessageId ? [`In-Reply-To: ${replyMessageId}`, `References: ${replyMessageId}`] : []),
  ];
  if (params.htmlBody !== undefined) {
    const boundary = "yoplai-gmail-boundary";
    return [...headers, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary=${boundary}`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", params.body ?? "", `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", params.htmlBody, `--${boundary}--`].join("\r\n");
  }
  return [...headers, "Content-Type: text/plain; charset=UTF-8", "", params.body ?? ""].join("\r\n");
}

export class GmailClient {
  constructor(private readonly accessToken: string, private readonly fetchImpl: GmailFetch = fetch) {}

  async createDraft(params: CreateDraftParams) {
    const reply = params.replyToMessageId
      ? await this.request(`/messages/${encodeURIComponent(params.replyToMessageId)}?format=metadata`) as GmailMessage
      : undefined;
    const message = {
      raw: Buffer.from(rawMessage(params, reply ? header(reply, "Message-ID") : undefined)).toString("base64url"),
      ...(reply?.threadId ? { threadId: reply.threadId } : {}),
    };
    const data = await this.request("/drafts", { method: "POST", body: JSON.stringify({ message }) }) as { id?: string };
    return this.getDraft(data.id ?? "");
  }
  async updateDraft(params: UpdateDraftParams) {
    // Gmail replaces the whole draft; omitted fields keep current values (HTML body is not preserved unless resent).
    const id = encodeURIComponent(params.draftId);
    const existing = (await this.request(`/drafts/${id}?format=full`) as { message?: GmailMessage }).message ?? {};
    const merged: CreateDraftParams = {
      to: params.to ?? recipients(existing, "To"),
      cc: params.cc ?? recipients(existing, "Cc"),
      bcc: params.bcc ?? recipients(existing, "Bcc"),
      subject: params.subject ?? header(existing, "Subject"),
      body: params.body ?? body(existing.payload),
      htmlBody: params.htmlBody,
    };
    const message = {
      raw: Buffer.from(rawMessage(merged, header(existing, "In-Reply-To") || undefined)).toString("base64url"),
      ...(existing.threadId ? { threadId: existing.threadId } : {}),
    };
    await this.request(`/drafts/${id}`, { method: "PUT", body: JSON.stringify({ id: params.draftId, message }) });
    return this.getDraft(params.draftId);
  }
  async deleteDraft(params: { draftId: string }) {
    await this.request(`/drafts/${encodeURIComponent(params.draftId)}`, { method: "DELETE" });
    return { deleted: true, draftId: params.draftId };
  }
  async account() {
    const profile = await this.request("/profile") as { emailAddress?: string };
    return profile.emailAddress ?? "";
  }
  async listDrafts(params: ListDraftsParams) {
    if (params.query) {
      // Gmail's drafts endpoint cannot filter. Search messages instead; its IDs
      // are message IDs, not Draft resource IDs (documented extension deviation).
      const query = new URLSearchParams({ maxResults: String(params.pageSize), q: `in:draft ${params.query}`, ...(params.pageToken ? { pageToken: params.pageToken } : {}) });
      const data = await this.request(`/messages?${query}`) as { messages?: GmailMessage[]; nextPageToken?: string };
      return { drafts: (data.messages ?? []).map((message) => this.draft(message.id ?? "", message)), nextPageToken: data.nextPageToken ?? null, draftIdKind: "message" as const };
    }
    const data = await this.request(`/drafts?${new URLSearchParams({ maxResults: String(params.pageSize), ...(params.pageToken ? { pageToken: params.pageToken } : {}) })}`) as { drafts?: Array<{ id?: string }>; nextPageToken?: string };
    const drafts = await Promise.all((data.drafts ?? []).map(async (item) => this.getDraft(item.id ?? "")));
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
    const threads = await Promise.all((data.threads ?? []).map(async (item) => this.getThread({ threadId: item.id ?? "", messageFormat: "MINIMAL" })));
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
  private async getDraft(id: string) { const data = await this.request(`/drafts/${encodeURIComponent(id)}?format=full`) as { id?: string; message?: GmailMessage }; return this.draft(data.id ?? id, data.message ?? {}); }
  private draft(id: string, message: GmailMessage) { return { id, subject: header(message, "Subject"), threadId: message.threadId ?? "", toRecipients: recipients(message, "To"), ccRecipients: recipients(message, "Cc"), bccRecipients: recipients(message, "Bcc"), plaintextBody: body(message.payload), date: date(message) }; }
  private async modify(path: string, labelIds: string[], remove: boolean) { await this.request(path, { method: "POST", body: JSON.stringify(remove ? { removeLabelIds: labelIds } : { addLabelIds: labelIds }) }); }
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(`${GMAIL_API_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
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
    return response.json().catch(() => ({}));
  }
}

export class GmailRequestError extends Error {
  constructor(readonly status: number, readonly endpoint: string, readonly method: string, readonly responseBody: string, readonly reason?: string) {
    super(`Gmail request failed (HTTP ${status}) ${method} ${endpoint}${responseBody ? `: ${responseBody}` : ""}`);
  }
}
