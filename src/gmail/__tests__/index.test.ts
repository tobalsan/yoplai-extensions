import { describe, expect, it, vi } from "vitest";
import extension from "../index.js";

const connected = { connected: true as const, provider: "google", accessToken: "secret", account: "owner@example.com", scopes: [] };

describe("gmail extension", () => {
  it("declares Google OAuth and the authoritative ten-tool surface", async () => {
    expect(extension.oauth).toEqual({ provider: "google", scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/userinfo.email"] });
    const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
    expect(tools.map((tool) => tool.name)).toEqual([
      "gmail_create_draft", "gmail_update_draft", "gmail_delete_draft", "gmail_list_drafts", "gmail_get_thread", "gmail_search_threads", "gmail_label_thread", "gmail_unlabel_thread", "gmail_list_labels", "gmail_label_message", "gmail_unlabel_message", "gmail_create_label",
    ]);
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

  it("returns reconnect guidance for an expired Gmail API token", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_list_labels")!.execute({})).resolves.toEqual({ connected: false, provider: "google", reason: "expired", message: "Gmail access has expired. Reconnect Google to continue." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["userRateLimitExceeded", "dailyLimitExceeded"])("returns retry guidance for Gmail rate limits (%s)", async (reason) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 }));
    try {
      const tools = await extension.getAgentTools({ id: "a1", extensions: { gmail: {} } }, { config: {}, resolveOAuth: vi.fn().mockResolvedValue(connected) });
      await expect(tools.find((tool) => tool.name === "gmail_list_labels")!.execute({})).resolves.toEqual({ connected: false, provider: "google", reason: "rate_limited", message: "Gmail is temporarily rate limited. Wait and retry." });
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
