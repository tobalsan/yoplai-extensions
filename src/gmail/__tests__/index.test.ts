import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "../index.js";

const connected = { connected: true as const, provider: "google", accessToken: "secret", account: "owner@example.com", scopes: [] };

describe("gmail extension", () => {
  it("offers sending as an off-by-default checkbox", () => {
    expect(extension.configJsonSchema).toMatchObject({
      properties: { allowSend: { type: "boolean", default: false, title: "Enable sending email" } },
    });
  });

  it("tells agents to confirm each send and respect attachment limits", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { gmail: {} } }, { config: {} },
    );
    const prompt = prompts!.join("\n");
    expect(prompt).toContain("never repeat it unnecessarily");
    expect(prompt).toContain("Send tools exist only when allowSend is enabled");
    expect(prompt).toContain("If they are not in your tool list, do not claim an email was sent");
    expect(prompt).toContain("confirm the recipients and the attachment with the user before each send, unless a scheduled job states the send rule");
    expect(prompt).toContain("conversation folder");
    expect(prompt).toContain("25 MiB");
    expect(prompt).toContain("36,700,160");
    expect(prompt).toContain("25,000,000");
    expect(prompt).toContain("10 files");
  });

  it("declares Google OAuth and the always-on tool surface", async () => {
    expect(extension.oauth).toEqual({ provider: "google", scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/userinfo.email"] });
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
    expect(tools.map((tool) => tool.name)).toEqual([
      "gmail_create_draft", "gmail_update_draft", "gmail_delete_draft", "gmail_list_drafts", "gmail_get_thread", "gmail_search_threads", "gmail_label_thread", "gmail_unlabel_thread", "gmail_list_labels", "gmail_label_message", "gmail_unlabel_message", "gmail_create_label", "gmail_download_attachment",
    ]);
  });

  it.each([
    [{}, {}, false],
    [{}, { allowSend: false }, false],
    [{}, { allowSend: true }, true],
    [{ allowSend: true }, {}, true],
    [{ allowSend: true }, { allowSend: false }, false],
  ])("mounts send tools only when merged allowSend is true (%j, %j)", async (root, agent, enabled) => {
    const tools = await extension.getAgentTools(
      { id: "a1", extensions: { gmail: agent } },
      { config: { extensions: { gmail: root } }, resolveOAuth: vi.fn().mockResolvedValue(connected) },
    );
    expect(tools.some((tool) => tool.name === "gmail_send_email")).toBe(enabled);
    expect(tools.some((tool) => tool.name === "gmail_send_draft")).toBe(enabled);
    expect(tools.some((tool) => tool.name === "gmail_download_attachment")).toBe(true);
  });

  it("returns a structured connection result without an access token", async () => {
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue({ connected: false, provider: "google", reason: "expired", message: "Reconnect Google.", authorizeUrl: "https://example.test/connect" }) });
    await expect(tools[0].execute({ to: ["person@example.com"] })).resolves.toEqual({ isError: true, connected: false, provider: "google", reason: "expired", message: "Reconnect Google.", authorizeUrl: "https://example.test/connect" });
  });

  it("rejects invalid official inputs before making a Gmail request", async () => {
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
    await expect(tools[0].execute({ to: ["not-an-email"] })).rejects.toThrow();
  });

  it("rejects draft subjects that could inject mail headers", async () => {
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
    await expect(tools[0].execute({ to: ["person@example.com"], subject: "Hello\r\nBcc: victim@example.com" })).rejects.toThrow("Subject must not contain line breaks");
  });

  it.each([
    ["gmail_create_draft", { to: [] }],
    ["gmail_list_drafts", { pageSize: 0 }],
    ["gmail_get_thread", { threadId: "" }],
    ["gmail_search_threads", { includeTrash: "true" }],
    ["gmail_label_thread", { threadId: "thread-1", labelIds: [] }],
    ["gmail_unlabel_thread", { threadId: "thread-1", labelIds: [] }],
    ["gmail_list_labels", { pageSize: 51 }],
    ["gmail_label_message", { messageId: "message-1", labelIds: [] }],
    ["gmail_unlabel_message", { messageId: "message-1", labelIds: [] }],
    ["gmail_create_label", { displayName: "" }],
  ])("rejects invalid %s input", async (name, invalid) => {
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
    await expect(tools.find((tool) => tool.name === name)!.execute(invalid)).rejects.toThrow();
  });

  it("identifies the connected mailbox on successful tool responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: "owner@example.com" }))).mockResolvedValueOnce(new Response(JSON.stringify({ labels: [] })));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      const labels = tools.find((tool) => tool.name === "gmail_list_labels")!;
      await expect(labels.execute({})).resolves.toEqual({ labels: [], nextPageToken: null, account: "owner@example.com" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([{ partId: "1" }, { filename: "invoice.pdf", size: 8 }])("downloads through tool execution when Gmail changes attachment IDs (%j)", async (selector) => {
    const hostPath = await mkdtemp(path.join(tmpdir(), "gmail-tool-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: "owner@example.com" }))
      .mockResolvedValueOnce(Response.json({ id: "message-1", payload: { parts: [{ partId: "1", filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "refreshed-attachment-1", size: 8 } }] } }))
      .mockResolvedValueOnce(Response.json({ size: 8, data: "JVBERi0xLjc" }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      const result = await tools.find((tool) => tool.name === "gmail_download_attachment")!.execute(
        { messageId: "message-1", attachmentId: "attachment-1", ...selector },
        { conversationFiles: { hostPath, runtimePath: "/conversation" } },
      ) as { path: string };
      expect(result).toMatchObject({ path: expect.stringMatching(/^\/conversation\/[^/]+-invoice\.pdf$/), name: "invoice.pdf", mimeType: "application/pdf", bytes: 8, account: "owner@example.com" });
      expect(await readFile(path.join(hostPath, path.basename(result.path)), "utf8")).toBe("%PDF-1.7");
      expect(vi.mocked(globalThis.fetch).mock.calls[2][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/attachments/attachment-1");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(hostPath, { recursive: true, force: true });
    }
  });

  it("sends a conversation attachment with CC and returns Gmail confirmation plus account", async () => {
    const hostPath = await mkdtemp(path.join(tmpdir(), "gmail-tool-"));
    await writeFile(path.join(hostPath, "invoice.pdf"), "%PDF-1.7");
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: "owner@example.com" }))
      .mockResolvedValueOnce(Response.json({ id: "sent-1", threadId: "thread-1" }));
    globalThis.fetch = fetchMock;
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: { allowSend: true } } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_send_email")!.execute(
        { to: ["recipient@example.com"], cc: ["reviewer@example.com"], body: "Invoice attached.", attachments: [{ path: "invoice.pdf" }] },
        { conversationFiles: { hostPath, runtimePath: "/conversation" } },
      )).resolves.toEqual({ messageId: "sent-1", threadId: "thread-1", account: "owner@example.com" });
      const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      expect(url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media");
      expect(new Headers(init.headers).get("content-type")).toBe("message/rfc822");
      const mime = String(init.body);
      expect(mime).toContain("Cc: reviewer@example.com\r\n");
      expect(mime).toContain('filename="invoice.pdf"');
      expect(mime).toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(hostPath, { recursive: true, force: true });
    }
  });

  it("cancels a hung mailbox check before sending and allows subsequent work", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let streamController!: ReadableStreamDefaultController;
    const stream = new ReadableStream({ start(value) { streamController = value; } });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(Response.json({ emailAddress: "owner@example.com" })).mockResolvedValueOnce(Response.json({ labels: [] }));
    globalThis.fetch = fetchMock;
    let outcome: Promise<unknown> | undefined;
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: { allowSend: true } } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      outcome = tools.find((tool) => tool.name === "gmail_send_email")!.execute({ to: ["a@example.com"], body: "Hello" }, { signal: controller.signal }).then(() => "sent", (error: Error) => error.message);
      setTimeout(() => controller.abort(new Error("cancelled mailbox check")), 5);
      expect(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("hung"), 50))])).toBe("cancelled mailbox check");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/messages/send"))).toBe(false);
      await expect(tools.find((tool) => tool.name === "gmail_list_labels")!.execute({})).resolves.toMatchObject({ labels: [], account: "owner@example.com" });
    } finally {
      try { streamController.close(); } catch { /* Already cancelled by the reader. */ }
      await outcome;
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["gmail_create_draft", "gmail_update_draft"])("passes conversation files to %s", async (name) => {
    const hostPath = await mkdtemp(path.join(tmpdir(), "gmail-tool-"));
    await writeFile(path.join(hostPath, "invoice.pdf"), "%PDF-1.7");
    const originalFetch = globalThis.fetch;
    const responses = [{ emailAddress: "owner@example.com" },
      ...(name === "gmail_update_draft" ? [{ id: "draft-1", message: { id: "m1", payload: { headers: [] } } }] : []),
      { id: "draft-1" }, { id: "draft-1", message: { id: "m1", payload: { headers: [], parts: [{ filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "a1", size: 8 } }] } } },
    ];
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(Response.json(response));
    globalThis.fetch = fetchMock;
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === name)!.execute(
        { ...(name === "gmail_update_draft" ? { draftId: "draft-1" } : {}), to: ["recipient@example.com"], body: "Invoice attached.", attachments: [{ path: "invoice.pdf" }] },
        { conversationFiles: { hostPath, runtimePath: "/conversation" } },
      )).resolves.toMatchObject({ id: "draft-1", attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 8 }], account: "owner@example.com" });
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      const [, init] = calls.find(([, init]) => init.method === "POST" || init.method === "PUT")!;
      const mime = String(init.body);
      expect(mime).toContain("Content-Type: multipart/mixed");
      expect(mime).toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(hostPath, { recursive: true, force: true });
    }
  });

  it("returns reconnect guidance for an expired Gmail API token", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_list_labels")!.execute({})).resolves.toEqual({ isError: true, connected: false, provider: "google", reason: "expired", message: "Gmail access has expired. Reconnect Google to continue." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks a download refused by OAuth as an error for structured-result hosts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_download_attachment")!.execute({ messageId: "m1", attachmentId: "a1" })).resolves.toMatchObject({ isError: true, connected: false, reason: "expired" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["userRateLimitExceeded", "dailyLimitExceeded"])("returns retry guidance for Gmail rate limits (%s)", async (reason) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_list_labels")!.execute({})).resolves.toEqual({ isError: true, connected: false, provider: "google", reason: "rate_limited", message: "Gmail is temporarily rate limited. Wait and retry." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ["gmail_create_draft", { to: ["person@example.com"], subject: "Hello" }, [{ id: "draft-1" }, { id: "draft-1", message: { payload: { headers: [] } } }]],
    ["gmail_list_drafts", {}, [{ drafts: [] }]],
    ["gmail_get_thread", { threadId: "thread-1" }, [{ id: "thread-1", messages: [] }]],
    ["gmail_search_threads", { query: "is:unread" }, [{ threads: [] }]],
    ["gmail_label_thread", { threadId: "thread-1", labelIds: ["LABEL"] }, [{}]],
    ["gmail_unlabel_thread", { threadId: "thread-1", labelIds: ["LABEL"] }, [{}]],
    ["gmail_list_labels", {}, [{ labels: [] }]],
    ["gmail_label_message", { messageId: "message-1", labelIds: ["LABEL"] }, [{}]],
    ["gmail_unlabel_message", { messageId: "message-1", labelIds: ["LABEL"] }, [{}]],
    ["gmail_create_label", { displayName: "Projects" }, [{ id: "LABEL", name: "Projects" }]],
  ])("executes %s through the host-injected token", async (name, input, operationResponses) => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: "owner@example.com" }))).mockResolvedValueOnce(new Response(JSON.stringify(operationResponses[0])));
    globalThis.fetch = fetchMock;
    for (const body of operationResponses.slice(1)) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === name)!.execute(input)).resolves.toMatchObject({ account: "owner@example.com" });
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
