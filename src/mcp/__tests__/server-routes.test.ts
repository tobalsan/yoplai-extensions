import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentials } from "./credentials.js";
import { createMcpExtension } from "../index.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function app() {
  const routes = new Map<string, (context: any) => Promise<any>>();
  return {
    routes,
    get(path: string, handler: (context: any) => Promise<any>) { routes.set(`GET ${path}`, handler); },
    post(path: string, handler: (context: any) => Promise<any>) { routes.set(`POST ${path}`, handler); },
  };
}

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
  it("lists existing stdio and HTTP servers, adds no-auth HTTP, and removes only the selected raw config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    const file = path.join(dir, "mcp.json");
    const original = { futureField: { keep: true }, mcpServers: {
      local: { command: "node", args: ["server.js"], env: { TOKEN: "${MCP_TOKEN}" }, future: 7 },
      docs: { url: "https://docs.example.test/mcp", future: "preserve" },
    } };
    await fs.writeFile(file, JSON.stringify(original));
    vi.stubEnv("MCP_TOKEN", "secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { recover: { url: "https://recover.example.test/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    let online = false;
    const factory = vi.fn(async (server: { name: string }) => {
      if (!online) throw new Error("offline");
      return {
        async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { ready: { url: "https://ready.example.test/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const extension = createMcpExtension(async (server) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
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
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } }),
      registerClient: vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: [redirectUri] }),
      startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { createMcpExtension: createExtension } = await import("../index.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const factory = vi.fn(async (server: { name: string }, token?: string) => {
      if (!token) throw new Error("missing token");
      return {
        async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
        async callTool() { return "pong"; }, async close() {},
      };
    });
    const extension = createExtension(factory);
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const added = await routes.routes.get("POST /mcp/servers")!(context({ agent: "agent-a" }, { url: "https://oauth.example.test/mcp", credentialScope: "team" }));
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-config-")); dirs.push(dir);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    const file = path.join(dir, "mcp.json");
    await fs.writeFile(file, JSON.stringify({ mcpServers: {} }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
      aimx: { command: "node", args: ["server.js"], displayName: "AIMX Mail", description: "Agent mailboxes" },
    } }));
    const factory = vi.fn(async (server: { name: string }) => ({
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
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

  it("renders a styled, escaped OAuth result page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-")); dirs.push(dir);
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const extension = createMcpExtension();
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent-a", workspaceDir: dir }) });
    const routes = app(); extension.registerRoutes(routes);
    const page = await routes.routes.get("GET /mcp/oauth/callback")!(context({ state: "<b>bad</b>", code: "code" }));
    expect(page.status).toBe(400);
    expect(page.value).toContain('class="card"');
    expect(page.value).toContain("Connection failed");
    expect(page.value).not.toContain("<b>");
  });
});
