import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const connection = (token: string): OAuthConnection => ({ client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" });

type Session = { tenant: string; closed: boolean; lists: number; token?: string };
async function fixture(onCall?: (session: Session, args: unknown) => Promise<unknown>, onClose?: (session: Session) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-chat-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "mcp.json");
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
  await store.write("agent", "remote", connection("alice"), { type: "personal", userId: "alice" });
  const sessions: Session[] = [];
  const extension = createMcpExtension(async (server, token) => {
    const session = { tenant: "home", closed: false, lists: 0, token }; sessions.push(session);
    return {
      async listTools() { session.lists++; return [{ server: server.name, name: "tenant", description: "Tenant", inputSchema: { type: "object" } }]; },
      async callTool(_name, args) { if (onCall) return onCall(session, args); const tenant = (args as { tenant?: string }).tenant; if (tenant) session.tenant = tenant; return { content: [{ type: "text", text: session.tenant }] }; },
      async close() { if (onClose) await onClose(session); session.closed = true; },
    };
  });
  const agent = { id: "agent", workspaceDir: dir, extensions: { mcp: { configPath } } };
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
  cleanups.push(() => extension.stop());
  const tools = await extension.getAgentTools(agent, { userId: "alice", config: {} });
  const tool = tools.find((entry) => entry.name === "mcp__remote__tenant")!;
  return { extension, agent, store, sessions, tool, configPath };
}

describe("OAuth MCP chat sessions", () => {
  it("keeps the selected tenant and lists tools once across calls in the same chat", async () => {
    const { tool, sessions } = await fixture();
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ content: [{ text: "customer" }] });
    expect(sessions).toHaveLength(2); // Discovery plus one call session.
    expect(sessions[1]).toMatchObject({ closed: false, lists: 1 });
  });

  it("closes idle sessions 15 minutes after the last finished call", async () => {
    vi.useFakeTimers();
    const { tool, sessions } = await fixture();
    await tool.execute({}, { userId: "alice", sessionId: "chat" });
    await vi.advanceTimersByTimeAsync(899_999);
    expect(sessions[1]!.closed).toBe(false);
    await tool.execute({}, { userId: "alice", sessionId: "chat" });
    await vi.advanceTimersByTimeAsync(899_999);
    expect(sessions[1]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[1]!.closed).toBe(true);
    await tool.execute({}, { userId: "alice", sessionId: "chat" });
    expect(sessions).toHaveLength(3);
  });
  it("keeps an active call open beyond the idle deadline", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const { tool, sessions } = await fixture(async () => { began(); await new Promise<void>((resolve) => { finish = resolve; }); return "done"; });
    const pending = tool.execute({}, { userId: "alice", sessionId: "chat" });
    await started;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sessions[1]!.closed).toBe(false);
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(899_999);
    expect(sessions[1]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[1]!.closed).toBe(true);
  });

  it("isolates other chats and requesters while sharing parallel first calls", async () => {
    const { tool, store, sessions } = await fixture();
    await store.write("agent", "remote", connection("bob"), { type: "personal", userId: "bob" });
    await Promise.all([tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "one" }), tool.execute({}, { userId: "alice", sessionId: "one" })]);
    await expect(tool.execute({}, { userId: "alice", sessionId: "one" })).resolves.toMatchObject({ content: [{ text: "customer" }] });
    await expect(tool.execute({}, { userId: "alice", sessionId: "two" })).resolves.toMatchObject({ content: [{ text: "home" }] });
    await expect(tool.execute({}, { userId: "bob", sessionId: "one" })).resolves.toMatchObject({ content: [{ text: "home" }] });
    expect(sessions).toHaveLength(4);
    expect(sessions[3]!.token).toBe("bob");
  });

  it("uses and closes a new client when chat or requester identity is absent", async () => {
    const { tool, store, sessions } = await fixture();
    await store.write("agent", "remote", connection("team"));
    for (let i = 0; i < 2; i++) {
      await expect(tool.execute({ tenant: "customer" }, { userId: "alice" })).resolves.toMatchObject({ content: [{ text: "customer" }] });
      await expect(tool.execute({}, { sessionId: "chat" })).resolves.toMatchObject({ content: [{ text: "home" }] });
    }
    expect(sessions).toHaveLength(5);
    expect(sessions.slice(1).every((session) => session.closed)).toBe(true);
    expect(sessions[2]!.token).toBe("team");
  });

  it("closes all call sessions when the extension stops", async () => {
    const { tool, extension, sessions } = await fixture();
    await tool.execute({}, { userId: "alice", sessionId: "one" });
    await tool.execute({}, { userId: "alice", sessionId: "two" });
    await extension.stop();
    expect(sessions.every((session) => session.closed)).toBe(true);
  });
  it("retries an expired transport session once and tells the caller its state reset", async () => {
    let expired = false;
    const { tool, sessions } = await fixture(async (session, args) => {
      if (expired) { expired = false; throw new StreamableHTTPError(404, "Session expired"); }
      session.tenant = (args as { tenant?: string }).tenant ?? session.tenant;
      return { content: [{ type: "text", text: session.tenant }] };
    });
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    expired = true;
    const response = await tool.execute({}, { userId: "alice", sessionId: "chat" });
    expect(response).toMatchObject({ sessionReset: true, content: [{ text: "home" }, { text: expect.stringMatching(/new MCP session.*default/i) }] });
    expect(sessions).toHaveLength(3);
    expect(sessions[1]!.closed).toBe(true);
  });
  it("ends old call sessions when configuration changes before refusing stale tools", async () => {
    const { tool, sessions, configPath, extension, agent } = await fixture();
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.mcpServers.remote.description = "Updated configuration";
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ reason: "configuration_changed" });
    expect(sessions[1]!.closed).toBe(true);
    const fresh = (await extension.getAgentTools(agent, { userId: "alice", config: {} })).find((entry) => entry.name === "mcp__remote__tenant")!;
    await expect(fresh.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ content: [{ text: "home" }] });
  });
  it("keeps session state after a call fails without a session-expiry transport error", async () => {
    let fail = false;
    const { tool } = await fixture(async (session, args) => {
      if (fail) { fail = false; throw new Error("Temporary tool failure"); }
      session.tenant = (args as { tenant?: string }).tenant ?? session.tenant;
      return { content: [{ type: "text", text: session.tenant }] };
    });
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    fail = true;
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).rejects.toThrow("Temporary tool failure");
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ content: [{ text: "customer" }] });
  });
  it("waits for a credential eviction already closing a session when stopped", async () => {
    let finish!: () => void;
    let began!: () => void;
    const closing = new Promise<void>((resolve) => { began = resolve; });
    const { tool, store, extension, sessions } = await fixture(undefined, async (session) => {
      if (session.tenant !== "customer") return;
      began();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    await store.write("agent", "remote", connection("replacement"), { type: "personal", userId: "alice" });
    await closing;
    let stopped = false;
    const stop = extension.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    finish();
    await stop;
    expect(sessions[1]!.closed).toBe(true);
  });
  it("ends sessions for the previous configuration path when tools reload", async () => {
    const { tool, extension, sessions, agent, configPath } = await fixture();
    await tool.execute({ tenant: "customer" }, { userId: "alice", sessionId: "chat" });
    const nextPath = path.join(path.dirname(configPath), "new-mcp.json");
    await fs.copyFile(configPath, nextPath);
    agent.extensions.mcp.configPath = nextPath;
    const tools = await extension.getAgentTools(agent, { userId: "alice", config: {} });
    expect(sessions[1]!.closed).toBe(true);
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ reason: "configuration_changed" });
    await expect(tools[0]!.execute({}, { userId: "alice", sessionId: "chat" })).resolves.toMatchObject({ content: [{ text: "home" }] });
  });
  it("stops retrying when the replacement session also expires", async () => {
    const { tool, sessions } = await fixture(async () => { throw new StreamableHTTPError(404, "Session expired"); });
    await expect(tool.execute({}, { userId: "alice", sessionId: "chat" })).rejects.toMatchObject({ code: 404 });
    expect(sessions).toHaveLength(3);
    expect(sessions.slice(1).every((session) => session.closed)).toBe(true);
  });

  it("returns a tool-level 404 error without replacing its session", async () => {
    const { tool, sessions } = await fixture(async () => ({ isError: true, content: [{ type: "text", text: "HTTP 404: location not found" }] }));
    const context = { userId: "alice", sessionId: "chat" };
    await expect(tool.execute({}, context)).resolves.toEqual({ isError: true, content: [{ type: "text", text: "HTTP 404: location not found" }] });
    await tool.execute({}, context);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.closed).toBe(false);
  });
  it("keeps a session when a tool's own payload includes connected false", async () => {
    const { tool, sessions } = await fixture(async () => ({ connected: false, provider: "device", content: [{ type: "text", text: "Device offline" }] }));
    const context = { userId: "alice", sessionId: "chat" };
    await tool.execute({}, context);
    await tool.execute({}, context);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.closed).toBe(false);
  });
});
