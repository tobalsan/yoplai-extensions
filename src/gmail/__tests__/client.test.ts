import { describe, expect, it, vi } from "vitest";
import { GmailClient } from "../client.js";

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

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

  it("returns Gmail attachment IDs, not filenames", async () => {
    const client = new GmailClient("token", vi.fn().mockResolvedValue(response({ id: "t1", messages: [{ id: "m1", payload: { headers: [], parts: [{ filename: "report.pdf", body: { attachmentId: "attachment-1" } }] } }] })));
    await expect(client.getThread({ threadId: "t1" })).resolves.toMatchObject({ messages: [{ attachmentIds: ["attachment-1"] }] });
  });

  it("uses the original message thread when creating a reply draft", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ threadId: "thread-1" }))
      .mockResolvedValueOnce(response({ id: "draft-1" }))
      .mockResolvedValueOnce(response({ id: "draft-1", message: { threadId: "thread-1", payload: { headers: [] } } }));
    const client = new GmailClient("token", fetchImpl);
    await client.createDraft({ to: ["person@example.com"], replyToMessageId: "message-1" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/messages/message-1");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).message.threadId).toBe("thread-1");
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
    const sent = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(sent.message.threadId).toBe("thread-1");
    const raw = Buffer.from(sent.message.raw, "base64url").toString("utf8");
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
