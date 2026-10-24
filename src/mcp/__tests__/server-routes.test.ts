import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentials } from "./credentials.js";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  await dirs.cleanup();
});

const app = routeApp;

function context(query: Record<string, string>, body?: unknown) {
  return {
    get: () => ({ user: { id: "user-a", role: "user" } }),
    req: { query: (key: string) => query[key], json: async () => body },
    json: (value: unknown) => value,
    text: (value: string, status?: number) => ({ value, status }),
    html: (value: string, status?: number) => ({ value, status }),
    redirect: (value: string) => ({ redirect: value }),
  };
}

describe("MCP server cards and self-service routes", () => {
  it("loads only the requested server and leaves other servers uncontacted", async () => {
    const dir = await dirs.make("mcp-filter-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { selected: { command: "selected" }, other: { command: "other" } } }));
    const contacted: string[] = [];
    const extension = createMcpExtension(async (server) => {
      contacted.push(server.name);
      return {
        async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
        async readResource() { return { contents: [] }; },
        async callTool() { return "pong"; },
        async close() {},
      };
    });
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    try {
      const result = await routes.routes.get("GET /mcp/servers")!(context({ agent: "casey", server: "selected" }));
      expect(result).toMatchObject({ servers: [{ name: "selected", state: "connected" }], canConfigureTeam: true, canEditLabels: true });
      expect(contacted).toEqual(["selected"]);
      await expect(routes.routes.get("GET /mcp/servers")!(context({ agent: "casey", server: "missing" }))).resolves.toMatchObject({ servers: [], canConfigureTeam: true, canEditLabels: true });
      expect(contacted).toEqual(["selected"]);
    } finally { await extension.stop(); }
  });

  it.each([
    ["tools", "failure"], ["tools", "timeout"], ["status", "failure"], ["status", "timeout"], ["recovery", "failure"],
  ] as const)("logs a shared refresh %s/%s with requester context and no second manager error", async (logPath, outcome) => {
    const dir = await dirs.make("mcp-refresh-context-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host);
    await store.write("casey", "remote", {
      client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", ...(logPath === "recovery" ? {} : { expiresAt: "2020-01-01T00:00:00Z" }), authorizationServerUrl: "https://auth.example.test",
    });
    let started!: () => void;
    let fail!: (error: Error) => void;
    const refreshing = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
      started(); return new Promise<Response>((_resolve, reject) => { fail = reject; });
    }));
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const extension = createMcpExtension(async () => ({
      async listTools() { throw Object.assign(new Error("401 Unauthorized"), { code: 401 }); },
      async readResource() { return { contents: [] }; },
      async callTool() { throw new Error("not listed"); }, async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    const routes = app(); extension.registerRoutes(routes);
    vi.useFakeTimers();
    try {
      const pending = Array.from({ length: 3 }, () => logPath !== "status"
        ? extension.getAgentTools(agent, { userId: "alice", config: {} })
        : routes.routes.get("GET /mcp/oauth/status")!(routeContext({ agent: "casey" }, { user: { id: "alice" } })));
      await refreshing;
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(10_001);
      else fail(new Error("provider unavailable"));
      await Promise.all(pending);
      expect(output.mock.calls).toHaveLength(1);
      expect(JSON.parse(output.mock.calls[0]![0])).toEqual({
        level: "error", msg: outcome === "timeout" ? '[mcp] server "remote" unavailable: OAuth refresh timed out' : '[mcp] server "remote" unavailable: provider unavailable',
        server: "remote", agentId: "casey", userId: "alice", path: logPath === "recovery" ? "tools" : logPath, reason: "refresh_failed", scope: "team",
      });
      if (logPath !== "status") expect(info.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({ reason: "refresh_failed", level: "info" }));
      else expect(info.mock.calls).toEqual([]);
    } finally { await extension.stop(); }
  });

  it("lists existing stdio and HTTP servers, adds no-auth HTTP, and removes only the selected raw config", async () => {
    const dir = await dirs.make("mcp-servers-");
    const file = path.join(dir, "mcp.json");
    const original = { futureField: { keep: true }, mcpServers: {
      local: { command: "node", args: ["server.js"], env: { TOKEN: "${MCP_TOKEN}" }, future: 7 },
      docs: { url: "https://docs.example.test/mcp", future: "preserve" },
    } };
    await fs.writeFile(file, JSON.stringify(original));
    vi.stubEnv("MCP_TOKEN", "secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "pong"; },
      async close() {},
      getServerIcon: () => server.name === "docs" ? "https://docs.example.test/icon.png" : undefined,
    }));
    const extension = createMcpExtension(factory);
    const record = vi.fn();
    await extension.start({ audit: { record }, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers).toEqual([
      expect.objectContaining({ name: "local", type: "stdio", state: "connected", readOnly: true }),
      expect.objectContaining({ name: "docs", type: "http", state: "connected", iconUrl: "https://docs.example.test/icon.png", readOnly: true }),
    ]);
    const added = await routes.routes.get("POST /mcp/servers")!(context({ agent: "agent-a" }, { url: "https://new.example.test/mcp", credentialScope: "team" }));
    expect(added.server).toMatchObject({ type: "http", auth: "none", state: "connected", readOnly: false });
    expect(added.authorizationUrl).toBeUndefined();
    const afterAdd = JSON.parse(await fs.readFile(file, "utf8"));
    expect(afterAdd.futureField).toEqual(original.futureField);
    expect(afterAdd.mcpServers.local).toEqual(original.mcpServers.local);
    expect(afterAdd.mcpServers.docs).toEqual(original.mcpServers.docs);
    await expect(routes.routes.get("POST /mcp/servers/remove")!(context({ agent: "agent-a", server: added.server.name }))).resolves.toEqual({ ok: true });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(original);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.add", targetId: added.server.name }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.remove", targetId: added.server.name }));
    await extension.stop();
  });

  it("keeps a server disconnected when a stored token cannot establish tools", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { offline: { url: "https://offline.example.test/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const extension = createMcpExtension(async () => { throw new Error("offline"); });
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers[0]).toMatchObject({ name: "offline", state: "disconnected" });
    await extension.stop();
  });

  it("retries a previously failed manager so a recovered card has callable tools", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { recover: { url: "https://recover.example.test/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    let online = false;
    const factory = vi.fn(async (server: { name: string }) => {
      if (!online) throw new Error("offline");
      return {
        async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
        async readResource() { return { contents: [] }; },
        async callTool() { return "pong"; }, async close() {},
      };
    });
    const extension = createMcpExtension(factory);
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const agent = { id: "agent-a", workspaceDir: dir };
    await expect(extension.getAgentTools(agent, { config: {} })).resolves.toEqual([]);
    online = true;
    const routes = app(); extension.registerRoutes(routes);
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers[0].state).toBe("connected");
    const tools = await extension.getAgentTools(agent, { config: {} });
    await expect(tools.find((tool) => tool.name === "mcp__recover__ping")?.execute({})).resolves.toBe("pong");
    expect(factory).toHaveBeenCalledTimes(3);
    await extension.stop();
  });

  it("returns a disconnected card when a server connection hangs", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slow: { command: "slow" } } }));
    const extension = createMcpExtension(async () => new Promise(() => {}));
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    vi.useFakeTimers();
    const result = routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toMatchObject({ servers: [expect.objectContaining({ name: "slow", state: "disconnected" })] });
    await extension.stop();
  });

  it("bounds a hanging HTTP probe and connection before returning a card", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slow: { url: "https://slow.example.test/mcp" } } }));
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const factory = vi.fn(async () => new Promise<never>(() => {}));
    const extension = createMcpExtension(factory);
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    while (!fetchMock.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_001);
    while (!factory.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toMatchObject({ servers: [expect.objectContaining({ name: "slow", state: "disconnected" })] });
    await extension.stop();
  });

  it("returns a connected card without waiting for a stuck close", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { ready: { url: "https://ready.example.test/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const extension = createMcpExtension(async (server) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "pong"; },
      async close() { return new Promise<void>(() => {}); },
    }));
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }))).resolves.toMatchObject({ servers: [expect.objectContaining({ state: "connected" })] });
    await extension.stop();
  });

  it("times out OAuth discovery before persisting a new server", async () => {
    const discover = vi.fn(() => new Promise(() => {}));
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: discover,
      registerClient: vi.fn(), startAuthorization: vi.fn(), exchangeAuthorization: vi.fn(),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { createMcpExtension: createExtension } = await import("../index.js");
    const dir = await dirs.make("mcp-servers-");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const extension = createExtension();
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = routes.routes.get("POST /mcp/servers")!(context({ agent: "agent-a" }, { url: "https://slow.example.test/mcp", credentialScope: "team" }));
    while (!discover.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(result).resolves.toMatchObject({ status: 400, value: "MCP OAuth authorization timed out" });
    await expect(fs.stat(path.join(dir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await extension.stop();
  });

  it("starts OAuth on add and shows connected only after a live MCP connection", async () => {
    const redirectUri = "http://localhost:4000/api/mcp/oauth/callback";
    const dir = await dirs.make("mcp-servers-");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://oauth.example.test/mcp", authorization_servers: ["https://auth.test"] });
      if (url.includes(".well-known")) return Response.json({ issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token", registration_endpoint: "https://auth.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      if (url === "https://auth.test/register") return Response.json({ client_id: "client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
      if (url === "https://auth.test/token") return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
      return new Response(null, { status: 401 });
    }));
    const factory = vi.fn(async (server: { name: string }, token?: string) => {
      if (!token) throw new Error("missing token");
      return {
        async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
        async readResource() { return { contents: [] }; },
        async callTool() { return "pong"; }, async close() {},
      };
    });
    const extension = createMcpExtension(factory);
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const added = await routes.routes.get("POST /mcp/servers")!(context({ agent: "agent-a" }, { url: "https://oauth.example.test/mcp", credentialScope: "team" }));
    expect(added).toMatchObject({ authorizationUrl: expect.any(String) });
    expect(added.authorizationUrl).toMatch(/^https:\/\/auth\.test\/authorize\?/);
    expect(added.server.state).toBe("disconnected");
    expect(JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8")).mcpServers[added.server.name]).toMatchObject({ url: "https://oauth.example.test/mcp" });
    const state = new URL(added.authorizationUrl).searchParams.get("state")!;
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ state, code: "code" }))).resolves.toMatchObject({ value: expect.stringContaining("success:true") });
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers[0]).toMatchObject({ state: "connected", teamState: "connected" });
    const tools = await extension.getAgentTools({ id: "agent-a", workspaceDir: dir }, { config: {}, userId: "user-a" });
    await expect(tools.find((tool) => tool.name === `mcp__${added.server.name}__ping`)?.execute({})).resolves.toBe("pong");
    await extension.stop();
  });
});

describe("MCP server config routes", () => {
  it("masks secrets, keeps masked values, rejects stdio edits, preserves other fields, audits", async () => {
    const dir = await dirs.make("mcp-config-");
    const file = path.join(dir, "mcp.json");
    const original = { futureField: 1, mcpServers: {
      local: { command: "node", env: { TOKEN: "secret" } },
      api: { url: "https://api.example.test/mcp", headers: { Authorization: "Bearer real" }, future: "x" },
    } };
    await fs.writeFile(file, JSON.stringify(original));
    const extension = createMcpExtension(async () => { throw new Error("offline"); });
    const record = vi.fn();
    await extension.start({ audit: { record }, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const get = routes.routes.get("GET /mcp/servers/config")!;
    const post = routes.routes.get("POST /mcp/servers/config")!;
    const shown = await get(context({ agent: "agent-a", server: "api" }));
    expect(shown).toMatchObject({ type: "http", editable: true, config: { headers: { Authorization: "••••••••" } } });
    expect(JSON.stringify(shown)).not.toContain("Bearer real");
    expect(await get(context({ agent: "agent-a", server: "local" }))).toMatchObject({ type: "stdio", editable: false, config: { env: { TOKEN: "••••••••" } } });
    const saved = await post(context({ agent: "agent-a", server: "api" }, { config: { url: "https://api2.example.test/mcp", headers: { Authorization: "••••••••", "X-New": "n" }, future: "x" } }));
    expect(saved).toMatchObject({ editable: true });
    const disk = JSON.parse(await fs.readFile(file, "utf8"));
    expect(disk.futureField).toBe(1);
    expect(disk.mcpServers.local).toEqual(original.mcpServers.local);
    expect(disk.mcpServers.api).toEqual({ url: "https://api2.example.test/mcp", headers: { Authorization: "Bearer real", "X-New": "n" }, future: "x" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.update", targetId: "api" }));
    expect(await post(context({ agent: "agent-a", server: "local" }, { config: { url: "https://x.example.test" } }))).toMatchObject({ status: 403 });
    expect(await post(context({ agent: "agent-a", server: "api" }, { config: { url: "https://x.example.test", command: "sh" } }))).toMatchObject({ status: 400 });
    expect(await post(context({ agent: "agent-a", server: "api" }, { config: { url: "ftp://x.example.test" } }))).toMatchObject({ status: 400 });
    expect(await post(context({ agent: "agent-a", server: "api" }, { config: { url: "https://x.example.test", headers: { "X-Unknown": "••••••••" } } }))).toMatchObject({ status: 400 });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(disk);
    await extension.stop();
  });

  it("names added servers after their site, dedupes, and stores the server-reported title", async () => {
    const dir = await dirs.make("mcp-servers-");
    const file = path.join(dir, "mcp.json");
    await fs.writeFile(file, JSON.stringify({ mcpServers: {} }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "pong"; },
      async close() {},
      getServerInfo: () => ({ title: "Linear", description: "Issues and projects" }),
    }));
    const extension = createMcpExtension(factory);
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const add = routes.routes.get("POST /mcp/servers")!;
    const first = await add(context({ agent: "agent-a" }, { url: "https://mcp.linear.app/mcp", credentialScope: "team" }));
    const second = await add(context({ agent: "agent-a" }, { url: "https://mcp.linear.app/sse", credentialScope: "team" }));
    expect([first.server.name, second.server.name]).toEqual(["linear", "linear_2"]);
    expect(first.server.title).toBe("Linear");
    expect(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.linear).toEqual({ url: "https://mcp.linear.app/mcp", yoplaiManaged: true, displayName: "Linear", description: "Issues and projects" });
    expect(first.server.description).toBe("Issues and projects");
    await extension.stop();
  });

  it("uses displayName and description from any server entry, including stdio", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
      aimx: { command: "node", args: ["server.js"], displayName: "AIMX Mail", description: "Agent mailboxes" },
    } }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "pong"; },
      async close() {},
    }));
    const extension = createMcpExtension(factory);
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers[0]).toMatchObject({ name: "aimx", type: "stdio", title: "AIMX Mail", description: "Agent mailboxes", state: "connected" });
    await extension.stop();
  });

  it("labels known hosted MCP servers that report generic server info", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { calendar: { url: "https://calendarmcp.googleapis.com/mcp/v1", yoplaiManaged: true } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "list_events", description: "List", visibility: ["model" as const, "app" as const], inputSchema: { type: "object" } }]; },
      async readResource() { return { contents: [] }; },
      async callTool() { return ""; },
      async close() {},
      getServerInfo: () => ({ title: "StatelessServer" }),
    }));
    const extension = createMcpExtension(factory);
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const list = await routes.routes.get("GET /mcp/servers")!(context({ agent: "agent-a" }));
    expect(list.servers).toEqual([expect.objectContaining({ name: "calendar", title: "Google Calendar", iconUrl: "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png" })]);
    // Persisted so file-based views (admin Top extensions) show the same label and icon.
    expect(JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8")).mcpServers.calendar.displayName).toBe("Google Calendar");
    expect(JSON.parse(await fs.readFile(path.join(dir, "mcp", "icons.json"), "utf8"))["calendarmcp.googleapis.com"]).toBe("https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png");
  });

  it("renders a styled, escaped OAuth result page", async () => {
    const dir = await dirs.make("mcp-servers-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const extension = createMcpExtension();
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const page = await routes.routes.get("GET /mcp/oauth/callback")!(context({ state: "<b>bad</b>", code: "code" }));
    expect(page.status).toBe(400);
    expect(page.value).toContain('class="card"');
    expect(page.value).toContain("Connection failed");
    expect(page.value).not.toContain("<b>");
    const denied = await routes.routes.get("GET /mcp/oauth/callback")!(context({ state: "s", error: "invalid_scope<b>" }));
    expect(denied.status).toBe(400);
    expect(denied.value).toContain("OAuth connection failed: invalid_scope");
    expect(denied.value).not.toContain("<b>");
  });

  it("rejects adding a server URL that is already configured", async () => {
    const dir = await dirs.make("mcp-servers-");
    const file = path.join(dir, "mcp.json");
    await fs.writeFile(file, JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.test/mcp" } } }));
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const result = await routes.routes.get("POST /mcp/servers")!(context({ agent: "agent-a" }, { url: "https://DOCS.example.test/mcp/", credentialScope: "team" }));
    expect(result).toMatchObject({ status: 409, value: "This MCP server has already been added." });
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).mcpServers)).toEqual(["docs"]);
  });
});
