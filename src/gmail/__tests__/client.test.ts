import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionContext } from "../../tool-extension.js";
import { describe, expect, it, vi } from "vitest";
import { GmailClient } from "../client.js";

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function uploaded(init: RequestInit): { mime: string; metadata?: unknown } {
  const contentType = new Headers(init.headers).get("content-type") ?? "";
  if (contentType === "message/rfc822") return { mime: String(init.body) };
  const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];
  expect(contentType).toContain("multipart/related");
  expect(boundary).toBeTruthy();
  const parts = String(init.body).split(`--${boundary}`);
  expect(parts).toHaveLength(4);
  expect(parts[1]).toContain("Content-Type: application/json");
  expect(parts[2]).toContain("Content-Type: message/rfc822");
  return { metadata: JSON.parse(parts[1].split("\r\n\r\n")[1]), mime: parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4, -2) };
}

async function conversation(run: (context: ToolExecutionContext, folder: string) => Promise<void>) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "gmail-test-"));
  try { await run({ conversationFiles: { hostPath: folder, runtimePath: "/conversation" } }, folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
const pdfMessage = { id: "m1", payload: { parts: [{ filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "a1", size: 8 } }] } };

describe("GmailClient", () => {
  it("searches threads with Gmail query pagination and returns minimal messages", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ threads: [{ id: "t1" }], nextPageToken: "next" }))
      .mockResolvedValueOnce(response({ id: "t1", messages: [{ id: "m1", snippet: "hello", payload: { headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "sender@example.com" }, { name: "Date", value: "2026-07-17" }] } }] }));
    const client = new GmailClient("token", fetchImpl);
    await expect(client.searchThreads({ query: "is:unread", pageSize: 20, pageToken: "old", includeTrash: true })).resolves.toEqual({ threads: [{ id: "t1", messages: [{ id: "m1", snippet: "hello", subject: "Hi", sender: "sender@example.com", toRecipients: [], ccRecipients: [], date: "2026-07-17" }] }], nextPageToken: "next" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("q=is%3Aunread");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("includeSpamTrash=true");
  });

  it("includes a truncated upstream response body and structured request details", async () => {
    const body = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] }, padding: "x".repeat(500) });
    const client = new GmailClient("super-secret", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    const error = await client.listLabels({ pageSize: 20 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 403,
      endpoint: "/labels",
      method: "GET",
      responseBody: body.slice(0, 500),
      reason: "rateLimitExceeded",
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(body.slice(0, 500));
  });

  it("searches draft messages when a draft query is supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ messages: [{ id: "message-1", threadId: "thread-1", payload: { headers: [] } }] }));
    const client = new GmailClient("token", fetchImpl);
    await expect(client.listDrafts({ query: "subject:proposal", pageSize: 20 })).resolves.toMatchObject({ draftIdKind: "message", drafts: [{ id: "message-1", threadId: "thread-1" }] });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("q=in%3Adraft+subject%3Aproposal");
  });

  it("lists only user labels and paginates them", async () => {
    const client = new GmailClient("token", vi.fn().mockResolvedValue(response({ labels: [{ id: "INBOX", type: "system" }, { id: "L1", name: "One", type: "user" }, { id: "L2", name: "Two", type: "user" }] })));
    await expect(client.listLabels({ pageSize: 1 })).resolves.toEqual({ labels: [{ labelId: "L1", name: "One", threadsTotal: 0, threadsUnread: 0 }], nextPageToken: "1" });
  });

  it("returns attachment metadata and keeps legacy IDs while excluding unnamed text parts", async () => {
    const client = new GmailClient("token", vi.fn().mockResolvedValue(response({ id: "t1", messages: [{ id: "m1", payload: { headers: [], parts: [{ partId: "1", filename: "report.pdf", mimeType: "application/pdf", body: { attachmentId: "attachment-1", size: 8 } }, { mimeType: "text/plain", body: { attachmentId: "large-text", size: 100 } }] } }] })));
    await expect(client.getThread({ threadId: "t1", messageFormat: "FULL_CONTENT" })).resolves.toMatchObject({ messages: [{ attachmentIds: ["attachment-1", "large-text"], attachments: [{ messageId: "m1", attachmentId: "attachment-1", partId: "1", filename: "report.pdf", mimeType: "application/pdf", size: 8 }] }] });
  });

  it("downloads original bytes across message reads that each change the attachment ID", async () => {
    await conversation(async (context, folder) => {
      let messageReads = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/threads/t1")) return response({ id: "t1", messages: [{ ...pdfMessage, payload: { parts: [{ ...pdfMessage.payload.parts[0], partId: "1" }] } }] });
        if (pathname.endsWith("/messages/m1")) return response({ ...pdfMessage, payload: { parts: [{ ...pdfMessage.payload.parts[0], partId: "1", body: { attachmentId: `changed-${++messageReads}`, size: 8 } }] } });
        if (pathname.endsWith("/messages/m1/attachments/a1")) return response({ size: 8, data: "JVBERi0xLjQ" });
        return response({ error: "Unknown attachment" }, 404);
      });
      const client = new GmailClient("token", fetchImpl);
      const thread = await client.getThread({ threadId: "t1", messageFormat: "FULL_CONTENT" });
      const attachment = thread.messages[0].attachments![0];
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.downloadAttachment({ messageId: attachment.messageId, attachmentId: attachment.attachmentId, partId: attachment.partId }, context);
        expect(result).toMatchObject({ name: "invoice.pdf", mimeType: "application/pdf", bytes: 8 });
        expect(result.path).toMatch(/^\/conversation\/[a-f0-9-]+-invoice\.pdf$/);
        expect(await readFile(path.join(folder, path.basename(result.path)), "utf8")).toBe("%PDF-1.4");
      }
      expect(messageReads).toBe(2);
    });
  });

  it("rejects declared over-limit attachments before downloading", async () => {
    await conversation(async (context, folder) => {
      const fetchImpl = vi.fn().mockResolvedValue(response({ ...pdfMessage, payload: { parts: [{ ...pdfMessage.payload.parts[0], body: { attachmentId: "a1", size: 26_214_401 } }] } }));
      await expect(new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "a1" }, context)).rejects.toMatchObject({ status: 413 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await readdir(folder)).toEqual([]);
    });
  });

  it("requires a part ID when filename and size identify multiple attachments", async () => {
    await conversation(async (context, folder) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "m1", payload: { parts: [
        { partId: "1", filename: "invoice.pdf", body: { attachmentId: "new-1", size: 8 } },
        { partId: "2", filename: "invoice.pdf", body: { attachmentId: "new-2", size: 8 } },
      ] } })).mockResolvedValueOnce(response({ data: "JVBERi0xLjQ" }));
      await expect(new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "old-2", filename: "invoice.pdf", size: 8 }, context)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("partId") });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await readdir(folder)).toEqual([]);
    });
  });

  it("counts streamed response bytes even when Gmail understates attachment size", async () => {
    await conversation(async (context, folder) => {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(35_000_000)); controller.close(); } });
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(pdfMessage)).mockResolvedValueOnce(new Response(stream));
      await expect(new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "a1" }, context)).rejects.toMatchObject({ status: 413 });
      expect(await readdir(folder)).toEqual([]);
    });
  });

  it("cancels a hung attachment response without leaving a file", async () => {
    await conversation(async (context, folder) => {
      const controller = new AbortController();
      context.signal = controller.signal;
      const stream = new ReadableStream({ start(streamController) { streamController.enqueue(new TextEncoder().encode('{"data":"')); } });
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(pdfMessage)).mockResolvedValueOnce(new Response(stream));
      const download = new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "a1" }, context);
      setTimeout(() => controller.abort(new Error("cancelled")), 5);
      await expect(download).rejects.toThrow("cancelled");
      expect(await readdir(folder)).toEqual([]);
    });
  }, 200);

  it("rechecks the decoded byte limit", async () => {
    await conversation(async (context, folder) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(pdfMessage)).mockResolvedValueOnce(response({ data: Buffer.alloc(26_214_401).toString("base64url") }));
      await expect(new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "a1" }, context)).rejects.toMatchObject({ status: 413 });
      expect(await readdir(folder)).toEqual([]);
    });
  });

  it("creates a mixed draft with a PDF, encoded French headers, and UTF-8 bodies", async () => {
    await conversation(async (context, folder) => {
      await writeFile(path.join(folder, "facturé.pdf"), "%PDF-1.4");
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1", message: pdfMessage }));
      const result = await new GmailClient("token", fetchImpl).createDraft({ to: ["person@example.com"], subject: "Facturé", body: "Bonjour Zoé", htmlBody: "<p>Bonjour Zoé</p>", attachments: [{ path: "facturé.pdf" }] }, context);
      expect(fetchImpl.mock.calls[0][0]).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media");
      expect(new Headers(fetchImpl.mock.calls[0][1].headers).get("content-type")).toBe("message/rfc822");
      const raw = String(fetchImpl.mock.calls[0][1].body);
      expect(raw).toContain("Content-Type: multipart/mixed;");
      expect(raw).toContain("Content-Type: multipart/alternative;");
      expect(raw).toContain("Subject: =?UTF-8?B?RmFjdHVyw6k=?=");
      expect(raw).toContain("filename*=UTF-8''factur%C3%A9.pdf");
      expect(raw).toContain("Content-Type: application/pdf");
      expect(raw).toContain("JVBERi0xLjQ=");
      expect(raw).toContain("Qm9uam91ciBab8Op");
      expect(result.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", size: 8 }]);
    });
  });

  it("accepts exactly 36,700,160 MIME bytes and rejects one byte more before draft creation", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1" }));
    const client = new GmailClient("token", fetchImpl);
    // This ASCII message has 97 header/separator bytes; the rest is its body.
    await client.createDraft({ to: ["person@example.com"], body: "x".repeat(36_700_063) });
    expect(Buffer.byteLength(uploaded(fetchImpl.mock.calls[0][1]).mime)).toBe(36_700_160);
    await expect(client.createDraft({ to: ["person@example.com"], body: "x".repeat(36_700_064) })).rejects.toMatchObject({ status: 413 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps draft attachments when an update omits attachments", async () => {
    const existing = { id: "d1", message: { ...pdfMessage, payload: { ...pdfMessage.payload, headers: [{ name: "To", value: "person@example.com" }] } } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(existing)).mockResolvedValueOnce(response({ data: "JVBERi0xLjQ" })).mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response(existing));
    await new GmailClient("token", fetchImpl).updateDraft({ draftId: "d1", subject: "Fixed" });
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/messages/m1/attachments/a1");
    expect(fetchImpl.mock.calls[2][0]).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/d1?uploadType=media");
    expect(fetchImpl.mock.calls[2][1].method).toBe("PUT");
    const raw = uploaded(fetchImpl.mock.calls[2][1]).mime;
    expect(raw).toContain("Subject: Fixed");
    expect(raw).toContain('filename="invoice.pdf"');
    expect(raw).toContain("JVBERi0xLjQ=");
  });

  it("preserves draft attachment bytes using the IDs from each current draft read", async () => {
    let draftReads = 0;
    const uploads: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (init?.method === "PUT") {
        uploads.push(String(init.body));
        return response({ id: "d1" });
      }
      if (pathname.endsWith("/drafts/d1")) return response({ id: "d1", message: { ...pdfMessage, payload: { parts: [{ ...pdfMessage.payload.parts[0], body: { attachmentId: `current-${++draftReads}`, size: 8 } }] } } });
      if (pathname.endsWith(`/messages/m1/attachments/current-${draftReads}`)) return response({ data: "JVBERi0xLjQ" });
      return response({ error: "Stale attachment ID" }, 404);
    });
    const client = new GmailClient("token", fetchImpl);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.updateDraft({ draftId: "d1", subject: "Fixed" })).resolves.toMatchObject({ attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 8 }] });
    }
    expect(uploads).toHaveLength(2);
    for (const mime of uploads) {
      expect(mime).toContain('filename="invoice.pdf"');
      expect(mime).toContain("JVBERi0xLjQ=");
    }
  });

  it("keeps a named attachment stored directly in the draft MIME part", async () => {
    const existing = { id: "d1", message: { id: "m1", payload: { parts: [{ filename: "note.txt", mimeType: "text/plain", body: { data: "SGVsbG8", size: 5 } }] } } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(existing)).mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response(existing));
    const result = await new GmailClient("token", fetchImpl).updateDraft({ draftId: "d1", subject: "Fixed" });
    const mime = uploaded(fetchImpl.mock.calls[1][1]).mime;
    expect(mime).toContain('filename="note.txt"');
    expect(mime).toContain("SGVsbG8=");
    expect(result.attachments).toEqual([{ filename: "note.txt", mimeType: "text/plain", size: 5 }]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);
  });

  it.each([false, true])("removes or replaces draft attachments when explicitly supplied (%s)", async (replace) => {
    await conversation(async (context, folder) => {
      await writeFile(path.join(folder, "new.pdf"), "replacement");
      const existing = { id: "d1", message: pdfMessage };
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(existing)).mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response(existing));
      await new GmailClient("token", fetchImpl).updateDraft({ draftId: "d1", attachments: replace ? [{ path: "new.pdf" }] : [] }, context);
      const raw = uploaded(fetchImpl.mock.calls[1][1]).mime;
      expect(raw).not.toContain("invoice.pdf");
      expect(raw.includes('filename="new.pdf"')).toBe(replace);
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);
    });
  });

  it("sends a reply with CC and a PDF using the message thread", async () => {
    await conversation(async (context, folder) => {
      await writeFile(path.join(folder, "invoice.pdf"), "%PDF-1.4");
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "old", threadId: "thread-1", payload: { headers: [{ name: "Message-ID", value: "<original@example.com>" }] } })).mockResolvedValueOnce(response({ id: "sent-1", threadId: "thread-1" }));
      await expect(new GmailClient("token", fetchImpl).sendEmail({ to: ["bank@example.com"], cc: ["reviewer@example.com"], subject: "Invoice", body: "Attached", replyToMessageId: "old", attachments: [{ path: "invoice.pdf" }] }, context)).resolves.toEqual({ messageId: "sent-1", threadId: "thread-1" });
      expect(fetchImpl.mock.calls[1][0]).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
      const sent = uploaded(fetchImpl.mock.calls[1][1]);
      expect(sent.metadata).toEqual({ threadId: "thread-1" });
      const raw = sent.mime;
      expect(raw).toContain("Cc: reviewer@example.com");
      expect(raw).toContain("In-Reply-To: <original@example.com>");
      expect(raw).toContain("References: <original@example.com>");
      expect(raw).toContain("JVBERi0xLjQ=");
    });
  });

  it("sends a draft resource ID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "sent-1", threadId: "t1" }));
    await expect(new GmailClient("token", fetchImpl).sendDraft({ draftId: "draft-1" })).resolves.toEqual({ messageId: "sent-1", threadId: "t1" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/drafts/send");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ id: "draft-1" });
  });

  it.each(["email", "draft"])("never reports sent %s when Gmail omits its message ID", async (kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ threadId: "t1" }));
    const client = new GmailClient("token", fetchImpl);
    await expect(kind === "email" ? client.sendEmail({ to: ["a@example.com"], body: "Hello" }) : client.sendDraft({ draftId: "d1" })).rejects.toThrow("message ID");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a send without a nonempty text or HTML body before contacting Gmail", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "sent" }));
    await expect(new GmailClient("token", fetchImpl).sendEmail({ to: ["person@example.com"], body: "", htmlBody: "" })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["escape", "symlink"])("rejects attachment %s before any draft or send request", async (kind) => {
    await conversation(async (context, folder) => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "gmail-outside-"));
      try {
        const secret = path.join(outside, "outside.pdf");
        await writeFile(secret, "outside");
        await symlink(secret, path.join(folder, "link.pdf"));
        const attachmentPath = kind === "symlink" ? "link.pdf" : "../outside.pdf";
        const fetchImpl = vi.fn();
        const client = new GmailClient("token", fetchImpl);
        await expect(client.createDraft({ to: ["a@example.com"], attachments: [{ path: attachmentPath }] }, context)).rejects.toMatchObject({ status: 400 });
        await expect(client.sendEmail({ to: ["a@example.com"], body: "Attached", attachments: [{ path: attachmentPath }] }, context)).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally { await rm(outside, { recursive: true, force: true }); }
    });
  });

  it("rejects unknown attachment IDs and downloads without conversation files", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(pdfMessage));
    const client = new GmailClient("token", fetchImpl);
    await expect(client.downloadAttachment({ messageId: "m1", attachmentId: "a1" })).rejects.toThrow("conversation files folder");
    await conversation(async (context, folder) => {
      await expect(client.downloadAttachment({ messageId: "m1", attachmentId: "unknown" }, context)).rejects.toMatchObject({ status: 404 });
      expect(await readdir(folder)).toEqual([]);
    });
  });

  it.each(["email", "draft"])("surfaces Gmail refusal for %s without retrying", async (kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { message: "refused" } }, 500));
    const client = new GmailClient("token", fetchImpl);
    await expect(kind === "email" ? client.sendEmail({ to: ["a@example.com"], body: "Hello" }) : client.sendDraft({ draftId: "d1" })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a hung send response and can still perform later work", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream({ start(streamController) { streamController.enqueue(new TextEncoder().encode('{"id":')); } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(response({ emailAddress: "a@example.com" }));
    const client = new GmailClient("token", fetchImpl);
    const sending = client.sendEmail({ to: ["a@example.com"], body: "Hello" }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled send")), 5);
    await expect(sending).rejects.toThrow("cancelled send");
    await expect(client.account()).resolves.toBe("a@example.com");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 200);

  it.each(["create", "update"])("cancels a hung draft readback after %s", async (operation) => {
    const controller = new AbortController();
    let streamController!: ReadableStreamDefaultController;
    const stream = new ReadableStream({ start(value) { streamController = value; } });
    const fetchImpl = vi.fn();
    if (operation === "update") fetchImpl.mockResolvedValueOnce(response({ id: "d1" }));
    fetchImpl.mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(response({ emailAddress: "a@example.com" }));
    const client = new GmailClient("token", fetchImpl);
    const context = { signal: controller.signal };
    const pending = operation === "create" ? client.createDraft({ to: ["a@example.com"] }, context) : client.updateDraft({ draftId: "d1" }, context);
    const outcome = pending.then(() => "success", (error: Error) => error.message);
    setTimeout(() => controller.abort(new Error("cancelled readback")), 5);
    try {
      expect(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("hung"), 50))])).toBe("cancelled readback");
      await expect(client.account()).resolves.toBe("a@example.com");
    } finally {
      if (!controller.signal.aborted) controller.abort();
      try { streamController.close(); } catch { /* Already cancelled by the reader. */ }
      await outcome;
    }
  });

  it("times out a hung attachment response and leaves no partial file", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutMock = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    try {
      await conversation(async (context, folder) => {
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":"')); } });
        const fetchImpl = vi.fn().mockResolvedValueOnce(response(pdfMessage)).mockResolvedValueOnce(new Response(stream));
        await expect(new GmailClient("token", fetchImpl).downloadAttachment({ messageId: "m1", attachmentId: "a1" }, context)).rejects.toMatchObject({ name: "TimeoutError" });
        expect(await readdir(folder)).toEqual([]);
      });
    } finally { timeoutMock.mockRestore(); }
  });

  it("accepts 25 MB of attachment originals and rejects one byte more before uploading", async () => {
    await conversation(async (context, folder) => {
      await writeFile(path.join(folder, "one.pdf"), Buffer.alloc(12_500_000));
      await writeFile(path.join(folder, "two.pdf"), Buffer.alloc(12_500_000));
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1" }));
      const client = new GmailClient("token", fetchImpl);
      const params = { to: ["a@example.com"], attachments: [{ path: "one.pdf" }, { path: "two.pdf" }] };
      await expect(client.createDraft(params, context)).resolves.toMatchObject({ id: "d1" });
      expect(fetchImpl.mock.calls[0][0]).toContain("/upload/gmail/v1/users/me/drafts");
      await writeFile(path.join(folder, "two.pdf"), Buffer.alloc(12_500_001));
      fetchImpl.mockClear();
      await expect(client.createDraft(params, context)).rejects.toMatchObject({ status: 413 });
      await expect(client.sendEmail({ ...params, body: "Attached" }, context)).rejects.toMatchObject({ status: 413 });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("accepts a normalized path inside the folder and rejects filename header injection", async () => {
    await conversation(async (context, folder) => {
      await writeFile(path.join(folder, "invoice.pdf"), "%PDF-1.4");
      await writeFile(path.join(folder, "bad\nname.pdf"), "%PDF-1.4");
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1" }));
      const client = new GmailClient("token", fetchImpl);
      await client.createDraft({ to: ["a@example.com"], attachments: [{ path: "sub/../invoice.pdf" }] }, context);
      await expect(client.createDraft({ to: ["a@example.com"], attachments: [{ path: "bad\nname.pdf" }] }, context)).rejects.toMatchObject({ status: 400 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  it("folds long Unicode subjects into valid RFC 2047 encoded words", async () => {
    const subject = "Échéance de février — ".repeat(8);
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1" }));
    await new GmailClient("token", fetchImpl).createDraft({ to: ["a@example.com"], subject, body: "Hello" });
    const raw = uploaded(fetchImpl.mock.calls[0][1]).mime;
    const words = raw.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g) ?? [];
    const subjectLines = raw.match(/^Subject:.*(?:\r\n [^\r\n]*)*/m)?.[0].split("\r\n") ?? [];
    expect(subjectLines.every((line) => line.length <= 76)).toBe(true);
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word.length <= 75)).toBe(true);
    expect(words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("")).toBe(subject);
  });

  it.each(["constructor", "__proto__"])("uses a binary MIME fallback for unknown extension %s", async (extension) => {
    await conversation(async (context, folder) => {
      const filename = `invoice.${extension}`;
      await writeFile(path.join(folder, filename), "%PDF-1.4");
      const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "d1" })).mockResolvedValueOnce(response({ id: "d1" }));
      await new GmailClient("token", fetchImpl).createDraft({ to: ["a@example.com"], attachments: [{ path: filename }] }, context);
      const raw = uploaded(fetchImpl.mock.calls[0][1]).mime;
      expect(raw).toContain("Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64");
    });
  });

  it("uses the original message thread when creating a reply draft", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ threadId: "thread-1" }))
      .mockResolvedValueOnce(response({ id: "draft-1" }))
      .mockResolvedValueOnce(response({ id: "draft-1", message: { threadId: "thread-1", payload: { headers: [] } } }));
    const client = new GmailClient("token", fetchImpl);
    await client.createDraft({ to: ["person@example.com"], replyToMessageId: "message-1" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/messages/message-1");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart");
    expect(uploaded(fetchImpl.mock.calls[1][1]).metadata).toEqual({ message: { threadId: "thread-1" } });
  });

  it("updates a draft, keeping omitted fields and thread", async () => {
    const existing = { id: "draft-1", message: { threadId: "thread-1", payload: { mimeType: "text/plain", body: { data: Buffer.from("old body").toString("base64url") }, headers: [{ name: "To", value: "a@example.com" }, { name: "Subject", value: "Old" }, { name: "In-Reply-To", value: "<m1@x>" }] } } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(existing))
      .mockResolvedValueOnce(response({ id: "draft-1" }))
      .mockResolvedValueOnce(response(existing));
    const client = new GmailClient("token", fetchImpl);
    await client.updateDraft({ draftId: "draft-1", subject: "New" });
    expect(fetchImpl.mock.calls[1][1].method).toBe("PUT");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/drafts/draft-1");
    const sent = uploaded(fetchImpl.mock.calls[1][1]);
    expect(sent.metadata).toEqual({ message: { threadId: "thread-1" } });
    const raw = sent.mime;
    expect(raw).toContain("Subject: New");
    expect(raw).toContain("To: a@example.com");
    expect(raw).toContain("In-Reply-To: <m1@x>");
    expect(raw).toContain("old body");
  });

  it("deletes a draft", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GmailClient("token", fetchImpl);
    await expect(client.deleteDraft({ draftId: "draft-1" })).resolves.toEqual({ deleted: true, draftId: "draft-1" });
    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/drafts/draft-1");
  });

  it.each([
    ["labels a thread", (client: GmailClient) => client.labelThread({ threadId: "thread-1", labelIds: ["LABEL"] }), "/threads/thread-1/modify", { addLabelIds: ["LABEL"] }],
    ["unlabels a thread", (client: GmailClient) => client.labelThread({ threadId: "thread-1", labelIds: ["LABEL"] }, true), "/threads/thread-1/modify", { removeLabelIds: ["LABEL"] }],
    ["labels a message", (client: GmailClient) => client.labelMessage({ messageId: "message-1", labelIds: ["LABEL"] }), "/messages/message-1/modify", { addLabelIds: ["LABEL"] }],
    ["unlabels a message", (client: GmailClient) => client.labelMessage({ messageId: "message-1", labelIds: ["LABEL"] }, true), "/messages/message-1/modify", { removeLabelIds: ["LABEL"] }],
  ])("%s", async (_name, action, path, payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const client = new GmailClient("token", fetchImpl);
    await expect(action(client)).resolves.toEqual({});
    expect(String(fetchImpl.mock.calls[0][0])).toContain(path);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(payload);
  });

  it("creates a label with its display name and color", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "LABEL", name: "Projects", color: { textColor: "#000000", backgroundColor: "#ffffff" } }));
    const client = new GmailClient("token", fetchImpl);
    await expect(client.createLabel({ displayName: "Projects", color: { textColor: "#000000", backgroundColor: "#ffffff" } })).resolves.toMatchObject({ labelId: "LABEL", name: "Projects" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: "Projects", color: { textColor: "#000000", backgroundColor: "#ffffff" } });
  });
  it("falls back to the HTML part as text when a message has no plain-text body", async () => {
    const html = "<html><head><style>p{color:red}</style></head><body><h1>Pipeline&nbsp;Health</h1><p>Weighted: 1&#160;681&nbsp;378 &euro;</p><table><tr><td>Stage</td><td>EUR</td></tr></table><script>x()</script></body></html>";
    const payload = { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/related", parts: [{ mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } }] }] };
    const client = new GmailClient("token", vi.fn().mockResolvedValue(response({ id: "t1", messages: [{ id: "m1", payload }] })));
    const thread = await client.getThread({ threadId: "t1" });
    const text = thread.messages[0].plaintextBody;
    expect(text).toContain("Pipeline Health");
    expect(text).toContain("Weighted: 1\u00a0681 378");
    expect(text).toContain("Stage\tEUR");
    expect(text).not.toMatch(/<|color:red|x\(\)/);
  });

  it("prefers the plain-text part when both exist", async () => {
    const enc = (v: string) => Buffer.from(v).toString("base64url");
    const payload = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: enc("plain version") } }, { mimeType: "text/html", body: { data: enc("<p>html version</p>") } }] };
    const client = new GmailClient("token", vi.fn().mockResolvedValue(response({ id: "t1", messages: [{ id: "m1", payload }] })));
    await expect(client.getThread({ threadId: "t1" })).resolves.toMatchObject({ messages: [{ plaintextBody: "plain version" }] });
  });
});
