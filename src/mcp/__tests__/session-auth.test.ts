import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import type { McpClientFactory } from "../client-manager.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const scope = { type: "personal" as const, userId: "alice" };
const connection = (token: string): OAuthConnection => ({ client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, refresh_token: "dummy-refresh", token_type: "Bearer" }, connectedAt: "2026-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" });

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-session-auth-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
  await store.write("first", "remote", connection("old"), scope);
  let nextId = 0;
  const closed: number[] = [];
  const cleanupTokens: Array<{ session: number; token: string | undefined }> = [];
  let requireFresh = false;
  let rejectAll = false;
  let refreshFails = false;
  let refreshes = 0;
  let resumeCall: (() => void) | undefined;
  let signalPaused: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
  const delivered: Array<{ session: number; token: string | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(".well-known/oauth-authorization-server")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
    if (url === "https://auth.example.test/token") { refreshes++; return refreshFails ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ access_token: "new", refresh_token: "dummy-refresh", token_type: "Bearer" }); }
    return new Response(null, { status: 404 });
  });
  const factory: McpClientFactory = async (server, initialToken, tokenProvider) => {
    const session = ++nextId;
    let tenant = "home";
    return {
      async listTools() { return [{ server: server.name, name: "data", description: "data", inputSchema: { type: "object" } }]; },
      async callTool(_name, args) {
        if ((args as { pause?: boolean }).pause) {
          await new Promise<void>((resolve) => { resumeCall = resolve; signalPaused!(); });
        }
        const token = tokenProvider ? await tokenProvider() : initialToken;
        delivered.push({ session, token });
        if (!token || rejectAll || (requireFresh && token !== "new")) throw Object.assign(new Error("Unauthorized"), { code: 401 });
        if ((args as { tenant?: string }).tenant) tenant = (args as { tenant: string }).tenant;
        return { session, tenant, token };
      },
      async close() { cleanupTokens.push({ session, token: tokenProvider ? await tokenProvider(true) : initialToken }); closed.push(session); },
    };
  };
  const extension = createMcpExtension(factory);
  const agents = ["first", "second"].map((id) => ({ id, workspaceDir: dir }));
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: (id) => agents.find((agent) => agent.id === id) });
  cleanup.push(() => extension.stop());
  async function tool(agent = agents[0]!) { return (await extension.getAgentTools(agent, { userId: "alice", config: {} })).find((entry) => entry.name === "mcp__remote__data")!; }
  return { store, extension, agents, closed, cleanupTokens, tool, delivered, paused, resume: () => resumeCall!(), requireFresh: () => { requireFresh = true; }, rejectAll: () => { rejectAll = true; }, failRefresh: () => { refreshFails = true; }, refreshes: () => refreshes };
}

it("refreshes concurrent unauthorized calls once while preserving the chat tenant and session", async () => {
  const t = await setup();
  const tool = await t.tool();
  const context = { userId: "alice", sessionId: "chat" };
  await expect(tool.execute({ tenant: "customer" }, context)).resolves.toEqual({ session: 2, tenant: "customer", token: "old" });
  t.requireFresh();
  const results = await Promise.all([tool.execute({}, context), tool.execute({}, context)]);
  expect(results).toEqual([{ session: 2, tenant: "customer", token: "new" }, { session: 2, tenant: "customer", token: "new" }]);
  expect(t.refreshes()).toBe(1);
  expect(t.closed).toEqual([]);
});

it("replacing a shared personal grant ends sessions on every agent before the new identity is used", async () => {
  const t = await setup();
  const first = await t.tool();
  const second = await t.tool(t.agents[1]!);
  const context = { userId: "alice", sessionId: "chat" };
  await expect(first.execute({ tenant: "customer" }, context)).resolves.toEqual({ session: 3, tenant: "customer", token: "old" });
  await expect(second.execute({ tenant: "other" }, context)).resolves.toEqual({ session: 4, tenant: "other", token: "old" });
  await t.store.write("first", "remote", connection("replacement"), scope);
  await expect(first.execute({}, context)).resolves.toEqual({ session: 5, tenant: "home", token: "replacement" });
  await expect(second.execute({}, context)).resolves.toEqual({ session: 6, tenant: "home", token: "replacement" });
  expect(t.closed).toEqual(expect.arrayContaining([3, 4]));
});

it("disconnecting a shared personal credential closes every agent session and fails closed", async () => {
  const t = await setup();
  const first = await t.tool();
  const second = await t.tool(t.agents[1]!);
  const context = { userId: "alice", sessionId: "chat" };
  await first.execute({}, context);
  await second.execute({}, context);
  await t.store.disconnect("first", "remote", scope);
  await expect(first.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false });
  await expect(second.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false });
  expect(t.closed).toEqual(expect.arrayContaining([3, 4]));
});

it("marks a still-unauthorized credential for reconnect and drops sessions on every agent", async () => {
  const t = await setup();
  const first = await t.tool();
  const second = await t.tool(t.agents[1]!);
  const context = { userId: "alice", sessionId: "chat" };
  await first.execute({}, context);
  await second.execute({}, context);
  t.rejectAll();
  await expect(first.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false, reason: "needs_reconnect", authorizeUrl: "/agents/first/edit" });
  await expect(second.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false });
  expect(t.closed).toEqual(expect.arrayContaining([3, 4]));
  expect(t.refreshes()).toBe(1);
});

it("a failed OAuth store refresh closes every cached session using that credential", async () => {
  const t = await setup();
  const first = await t.tool();
  const second = await t.tool(t.agents[1]!);
  const context = { userId: "alice", sessionId: "chat" };
  await first.execute({}, context);
  await second.execute({}, context);
  t.failRefresh();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await t.store.refreshAccessToken("first", "remote", "alice", scope);
  await expect(first.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false });
  await expect(second.execute({}, context)).resolves.toMatchObject({ isError: true, connected: false });
  expect(t.closed).toEqual(expect.arrayContaining([3, 4]));
});

it("shares one credential refresh across simultaneous 401s from different chats", async () => {
  const t = await setup();
  const tool = await t.tool();
  await tool.execute({ tenant: "one" }, { userId: "alice", sessionId: "one" });
  await tool.execute({ tenant: "two" }, { userId: "alice", sessionId: "two" });
  t.requireFresh();
  const results = await Promise.all([
    tool.execute({}, { userId: "alice", sessionId: "one" }),
    tool.execute({}, { userId: "alice", sessionId: "two" }),
  ]);
  expect(results).toEqual([{ session: 2, tenant: "one", token: "new" }, { session: 3, tenant: "two", token: "new" }]);
  expect(t.refreshes()).toBe(1);
});

it("never sends a replacement account token on an old session whose call was already pending", async () => {
  const t = await setup();
  const tool = await t.tool();
  const context = { userId: "alice", sessionId: "chat" };
  await tool.execute({ tenant: "customer" }, context);
  const pending = tool.execute({ pause: true }, context);
  await t.paused;
  await t.store.write("first", "remote", connection("replacement"), scope);
  t.resume();
  await expect(pending).resolves.toMatchObject({ connected: false });
  expect(t.delivered).not.toContainEqual({ session: 2, token: "replacement" });
  await expect(tool.execute({}, context)).resolves.toEqual({ session: 3, tenant: "home", token: "replacement" });
});

it("invalidates a replaced team grant before asynchronous legacy-file cleanup finishes", async () => {
  const t = await setup();
  await t.store.write("first", "remote", connection("team-old"), { type: "team" });
  const tool = await t.tool();
  const context = { userId: "bob", sessionId: "chat" };
  await expect(tool.execute({ tenant: "team-customer" }, context)).resolves.toEqual({ session: 2, tenant: "team-customer", token: "team-old" });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const cleaning = new Promise<void>((resolve) => { entered = resolve; });
  const remove = vi.spyOn(fs, "rm").mockImplementationOnce(async () => { entered(); await blocked; });
  const replacement = t.store.write("first", "remote", connection("team-new"), { type: "team" });
  await cleaning;
  try {
    await expect(tool.execute({}, context)).resolves.toEqual({ session: 3, tenant: "home", token: "team-new" });
    expect(t.delivered).not.toContainEqual({ session: 2, token: "team-new" });
  } finally { release(); await replacement; remove.mockRestore(); }
});

it("ends every disconnected chat with the latest token refreshed by another chat", async () => {
  const t = await setup();
  const tool = await t.tool();
  await tool.execute({}, { userId: "alice", sessionId: "one" });
  await tool.execute({}, { userId: "alice", sessionId: "two" });
  t.requireFresh();
  await tool.execute({}, { userId: "alice", sessionId: "two" });
  await t.store.disconnect("first", "remote", scope);
  await t.extension.stop();
  expect(t.cleanupTokens).toEqual(expect.arrayContaining([{ session: 2, token: "new" }, { session: 3, token: "new" }]));
});

it("changes scope between calls without changing the identity of a pending personal session", async () => {
  const t = await setup();
  await t.store.write("first", "remote", connection("team"), { type: "team" });
  const tool = await t.tool();
  const context = { userId: "alice", sessionId: "chat" };
  await tool.execute({ tenant: "personal-customer" }, context);
  const pending = tool.execute({ pause: true }, context);
  await t.paused;
  await t.store.disconnect("first", "remote", scope);
  t.resume();
  await expect(pending).resolves.toMatchObject({ isError: true, connected: false });
  expect(t.delivered).not.toContainEqual({ session: 2, token: "team" });
  await expect(tool.execute({}, context)).resolves.toEqual({ session: 3, tenant: "home", token: "team" });
  await t.store.write("first", "remote", connection("new-personal"), scope);
  await expect(tool.execute({}, context)).resolves.toEqual({ session: 4, tenant: "home", token: "new-personal" });
});
