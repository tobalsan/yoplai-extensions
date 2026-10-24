import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";
import { routeApp, routeContext } from "./harness.js";
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
function connection(token: string): OAuthConnection {
  return { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" };
}
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-requester-")); dirs.push(dir); return dir; }
async function appsRequester() {
  const dir = await directory();
  const configPath = path.join(dir, "mcp.json");
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
  const selected: Array<{ token: string | undefined; url: string | undefined }> = [];
  const extension = createMcpExtension(async (server, token) => {
    const url = server.type === "http" ? server.url : undefined;
    selected.push({ token, url });
    return {
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: { type: "object" }, visibility: ["model", "app"] as ("model" | "app")[] }]; },
      async callTool() { return { content: [{ type: "text", text: token ?? "static" }], structuredContent: { url } }; },
      async readResource(uri) { return { contents: [{ uri, text: token ?? "static" }] }; },
      async close() {},
    };
  });
  const agent = { id: "casey", workspaceDir: dir };
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: (id) => id === "casey" ? agent : undefined });
  return { dir, configPath, store, selected, extension };
}
describe("MCP requester isolation", () => {
  it("cancels the viewer's OAuth metadata request and starts no token request after abort", async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
    await store.write("casey", "remote", { ...connection("expired"), tokens: { access_token: "expired", token_type: "Bearer", refresh_token: "refresh" }, expiresAt: "2020-01-01T00:00:00Z" }, { type: "personal", userId: "viewer" });
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (response: Response) => void;
    let upstreamSignal: AbortSignal | null | undefined;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url)); upstreamSignal = init?.signal; started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const factory = vi.fn(async () => { throw new Error("must not connect after cancellation"); });
    const extension = createMcpExtension(factory);
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    const controller = new AbortController();
    try {
      const pending = extension.mcpApps.readResource({ agentId: "casey", userId: "viewer", signal: controller.signal }, "remote", "ui://remote/view");
      await fetching;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "McpAppsError", reason: "aborted" });
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      finish(Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toEqual(["https://auth.example.test/.well-known/oauth-authorization-server"]);
      expect(factory).not.toHaveBeenCalled();
      await extension.stop();
    }
  });

  it("logs one unconnected state across tool loads, fresh status managers and execution identity", async () => {
    vi.useFakeTimers();
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
    await store.write("casey", "remote", { ...connection("A"), account: "Alice" }, { type: "personal", userId: "alice" });
    // Icon discovery is an external adapter, unrelated to connection/logging behavior.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const extension = createMcpExtension(async (server) => ({
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: { type: "object" }, visibility: ["model", "app"] }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "ok"; }, async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    const app = routeApp(); extension.registerRoutes(app);
    try {
      const [tool] = await extension.getAgentTools(agent, { userId: "alice", config: {} });
      for (let attempt = 0; attempt < 3; attempt++) {
        await extension.getAgentTools(agent, { userId: "bob", config: {} });
        await app.routes.get("GET /mcp/servers")!(routeContext({ agent: "casey" }, { user: { id: "bob" } }));
        await expect(tool!.execute({}, { userId: "bob" })).resolves.toMatchObject({ connected: false });
      }
      expect(errors.mock.calls).toEqual([]);
      expect(info.mock.calls).toHaveLength(1);
      expect(JSON.parse(info.mock.calls[0]![0])).toEqual({
        level: "info", msg: '[mcp] server "remote" unavailable: OAuth connection required',
        server: "remote", agentId: "casey", userId: "bob", path: "tools", reason: "not_connected",
      });
      await tool!.execute({});
      expect(JSON.parse(info.mock.calls[1]![0])).toMatchObject({ userId: "anonymous", path: "call" });
      await vi.advanceTimersByTimeAsync(3_599_999);
      await tool!.execute({}, { userId: "bob" });
      expect(info.mock.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await tool!.execute({}, { userId: "bob" });
      expect(info.mock.calls).toHaveLength(3);
      await store.write("casey", "remote", { ...connection("B"), account: "Bob" }, { type: "personal", userId: "bob" });
      await expect(tool!.execute({}, { userId: "bob" })).resolves.toBe("ok");
      await store.delete("casey", "remote", { type: "personal", userId: "bob" });
      await tool!.execute({}, { userId: "bob" });
      expect(info.mock.calls).toHaveLength(4);
      await extension.stop();
      await extension.getAgentTools(agent, { userId: "bob", config: {} });
      expect(info.mock.calls).toHaveLength(5);
    } finally { await extension.stop(); }
  });

  it("uses executor identity instead of discovery identity, including revoked personal credentials", async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://claap.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://claap.example.test/mcp", clientId: "client" }));
    await store.write("casey", "claap", connection("A"), { type: "personal", userId: "A" });
    const calls = vi.fn((token: string | undefined) => token);
    const extension = createMcpExtension(async (server, token) => ({
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: { type: "object" }, visibility: ["model", "app"] }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return calls(token); }, async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir, extensions: { mcp: { enabled: true } } };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    try {
      const tools = await extension.getAgentTools(agent, { userId: "A", config: {} });
      const tool = tools.find((entry) => entry.name === "mcp__claap__data");
      expect(tool).toBeDefined();
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("A");
      await expect(tool!.execute({}, { userId: "B" })).resolves.toMatchObject({ connected: false, authorizeUrl: "/agents/casey/edit" });
      await expect(tool!.execute({})).resolves.toMatchObject({ connected: false });
      expect(calls.mock.calls).toEqual([["A"]]);
      await store.write("casey", "claap", connection("team"));
      await expect(tool!.execute({}, { userId: "B" })).resolves.toBe("team");
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("A");
      await store.delete("casey", "claap", { type: "personal", userId: "A" });
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("team");
    } finally { await extension.stop(); }
  });
  it.each(["personal", "team"] as const)("logs known reconnect state at info with selected %s scope", async (type) => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host);
    await store.write("casey", "remote", { ...connection("known-token"), state: "needs_reconnect" }, type === "personal" ? { type, userId: "alice" } : { type });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory = vi.fn(async () => { throw new Error("must not connect without a token"); });
    const extension = createMcpExtension(factory);
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    try {
      await extension.getAgentTools(agent, { userId: "alice", config: {} });
      expect(errors.mock.calls).toEqual([]);
      expect(factory).not.toHaveBeenCalled();
      expect(info.mock.calls).toHaveLength(1);
      expect(JSON.parse(info.mock.calls[0]![0])).toEqual({
        level: "info", msg: '[mcp] server "remote" unavailable: OAuth connection required',
        server: "remote", agentId: "casey", userId: "alice", path: "tools", reason: "needs_reconnect", scope: type,
      });
    } finally { await extension.stop(); }
  });
  it("bounds a hanging personal refresh and leaves team credentials usable", async () => {
    const store = new McpOAuthStore(await directory(), "http://localhost/callback", credentials());
    await store.write("casey", "claap", connection("team"));
    await store.write("casey", "claap", { ...connection("A"), tokens: { access_token: "A", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z" }, { type: "personal", userId: "A" });
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>(() => {}); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const refresh = store.accessToken("casey", "claap", 60_000, "A");
    await fetching;
    await expect(store.accessToken("casey", "claap", 60_000, "B")).resolves.toBe("team");
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(refresh).resolves.toBeUndefined();
    await expect(store.read("casey", "claap", { type: "personal", userId: "A" })).resolves.toMatchObject({ state: "needs_reconnect" });
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ state: "connected" });
  });
  it.each(["delete", "reconnect"] as const)("does not overwrite a credential after %s during refresh", async (action) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new McpOAuthStore(await directory(), "http://localhost/callback", credentials());
    const scope = { type: "personal" as const, userId: "A" };
    await store.write("casey", "claap", { ...connection("A"), tokens: { access_token: "A", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z" }, scope);
    let started!: () => void;
    let finish!: (response: Response) => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const refresh = store.accessToken("casey", "claap", 60_000, "A");
    await fetching;
    if (action === "delete") await store.delete("casey", "claap", scope);
    else await store.write("casey", "claap", connection("new"), scope);
    finish(Response.json({ access_token: "late", token_type: "Bearer", expires_in: 3600 }));
    await expect(refresh).resolves.toBeUndefined();
    if (action === "delete") await expect(store.read("casey", "claap", scope)).resolves.toBeUndefined();
    else await expect(store.read("casey", "claap", scope)).resolves.toMatchObject({ tokens: { access_token: "new" }, state: "connected" });
    expect(output.mock.calls).toEqual([]);
  });

  it("uses each app viewer's personal grant without prior model discovery", async () => {
    const { extension, store, selected } = await appsRequester();
    await store.write("casey", "remote", connection("viewer-A"), { type: "personal", userId: "A" });
    await store.write("casey", "remote", connection("viewer-B"), { type: "personal", userId: "B" });
    try {
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "A" }, "remote", "data", {})).resolves.toMatchObject({ content: [{ type: "text", text: "viewer-A" }] });
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "B" }, "remote", "data", {})).resolves.toMatchObject({ content: [{ type: "text", text: "viewer-B" }] });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "A" }, "remote", "ui://remote/view")).resolves.toEqual({ contents: [{ uri: "ui://remote/view", text: "viewer-A" }] });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "B" }, "remote", "ui://remote/view")).resolves.toEqual({ contents: [{ uri: "ui://remote/view", text: "viewer-B" }] });
      expect(selected).toEqual([
        { token: "viewer-A", url: "https://remote.example.test/mcp" },
        { token: "viewer-B", url: "https://remote.example.test/mcp" },
        { token: "viewer-A", url: "https://remote.example.test/mcp" },
        { token: "viewer-B", url: "https://remote.example.test/mcp" },
      ]);
    } finally { await extension.stop(); }
  });

  it("uses the team grant only when an app viewer has no personal grant", async () => {
    const { extension, store, selected } = await appsRequester();
    await store.write("casey", "remote", connection("team"));
    await store.write("casey", "remote", connection("viewer-A"), { type: "personal", userId: "A" });
    try {
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "B" }, "remote", "data", {})).resolves.toMatchObject({ content: [{ type: "text", text: "team" }] });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "B" }, "remote", "ui://remote/view")).resolves.toEqual({ contents: [{ uri: "ui://remote/view", text: "team" }] });
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "A" }, "remote", "data", {})).resolves.toMatchObject({ content: [{ type: "text", text: "viewer-A" }] });
      expect(selected.map((entry) => entry.token)).toEqual(["team", "team", "viewer-A"]);
    } finally { await extension.stop(); }
  });

  it("refuses a broken personal app grant without falling back to the team", async () => {
    const { extension, store, selected } = await appsRequester();
    await store.write("casey", "remote", connection("team"));
    await store.write("casey", "remote", { ...connection("broken-B"), state: "needs_reconnect" }, { type: "personal", userId: "B" });
    try {
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "B" }, "remote", "data", {})).rejects.toMatchObject({ name: "McpAppsError", reason: "needs_reconnect", authorizeUrl: "/agents/casey/edit" });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "B" }, "remote", "ui://remote/view")).rejects.toMatchObject({ name: "McpAppsError", reason: "needs_reconnect", authorizeUrl: "/agents/casey/edit" });
      expect(selected).toEqual([]);
    } finally { await extension.stop(); }
  });

  it("offers a connect link when an app viewer has no available grant", async () => {
    const { extension, selected } = await appsRequester();
    try {
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "B" }, "remote", "data", {})).rejects.toMatchObject({ name: "McpAppsError", reason: "not_connected", authorizeUrl: "/agents/casey/edit" });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "B" }, "remote", "ui://remote/view")).rejects.toMatchObject({ name: "McpAppsError", reason: "not_connected", authorizeUrl: "/agents/casey/edit" });
      expect(selected).toEqual([]);
    } finally { await extension.stop(); }
  });

  it("resolves changed and removed app server configuration on each operation", async () => {
    const { extension, store, selected, configPath } = await appsRequester();
    await store.write("casey", "remote", connection("viewer-A"), { type: "personal", userId: "A" });
    try {
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "A" }, "remote", "data", {})).resolves.toMatchObject({ structuredContent: { url: "https://remote.example.test/mcp" } });
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: { remote: { url: "https://replacement.example.test/mcp", headers: { "X-Fixture": "static" } } } }));
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "A" }, "remote", "data", {})).resolves.toMatchObject({ content: [{ type: "text", text: "static" }], structuredContent: { url: "https://replacement.example.test/mcp" } });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "A" }, "remote", "ui://remote/view")).resolves.toEqual({ contents: [{ uri: "ui://remote/view", text: "static" }] });
      await fs.rm(configPath);
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "A" }, "remote", "data", {})).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_server" });
      await expect(extension.mcpApps.readResource({ agentId: "casey", userId: "A" }, "remote", "ui://remote/view")).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_server" });
      expect(selected).toEqual([
        { token: "viewer-A", url: "https://remote.example.test/mcp" },
        { token: undefined, url: "https://replacement.example.test/mcp" },
        { token: undefined, url: "https://replacement.example.test/mcp" },
      ]);
    } finally { await extension.stop(); }
  });

});
