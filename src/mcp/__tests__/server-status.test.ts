import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await dirs.cleanup(); });

it("returns stored fast cards and grant labels without any network work", async () => {
  const dir = await dirs.make("mcp-fast-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
    personal: { url: "https://personal.example.test/mcp", displayName: "My server", description: "Saved description" },
    team: { url: "https://team.example.test/mcp" },
    plain: { url: "https://plain.example.test/mcp" },
    static: { url: "https://static.example.test/mcp", headers: { Authorization: "test" } },
    local: { command: "node" },
  } }));
  await fs.mkdir(path.join(dir, "mcp"));
  await fs.writeFile(path.join(dir, "mcp/icons.json"), JSON.stringify({ "personal.example.test": "https://personal.example.test/icon.png" }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  const connection = { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "test", token_type: "Bearer" }, authorizationServerUrl: "https://auth.example.test", state: "needs_reconnect" as const, account: "alice@example.test" };
  await store.write("agent", "personal", connection, { type: "personal", userId: "user-a" });
  await store.write("agent", "team", { ...connection, state: "connected", account: undefined });
  const network = vi.fn(() => { throw new Error("unexpected network"); });
  vi.stubGlobal("fetch", network);
  const extension = createMcpExtension(network);
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  const get = app.routes.get("GET /mcp/servers")!;
  const result = await get(routeContext({ agent: "agent", live: "0" }));
  expect(result).toMatchObject({ servers: [
    { name: "personal", title: "My server", description: "Saved description", url: "https://personal.example.test/mcp", iconUrl: "https://personal.example.test/icon.png", auth: "oauth", personalState: "needs_reconnect", teamState: "disconnected", personalAccount: "alice@example.test", state: "disconnected", status: "pending" },
    { name: "team", auth: "oauth", teamState: "connected", state: "disconnected", status: "pending" },
    { name: "plain", auth: "none", state: "disconnected", status: "pending" },
    { name: "static", auth: "static", state: "disconnected", status: "pending" },
    { name: "local", auth: "stdio", state: "disconnected", status: "pending" },
  ] });
  expect(network).not.toHaveBeenCalled();
  await expect(get(routeContext({ agent: "agent", server: "missing", live: "0" }))).resolves.toMatchObject({ servers: [] });
  await extension.stop();
});

it("bounds a single hanging server status to ten seconds and keeps personal OAuth data", async () => {
  const dir = await dirs.make("mcp-status-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slow: { url: "https://slow.example.test/mcp" }, other: { url: "https://other.example.test/mcp" } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "slow", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "test", token_type: "Bearer" }, authorizationServerUrl: "https://auth.example.test", state: "connected", account: "alice@example.test" }, { type: "personal", userId: "user-a" });
  const network = vi.fn(() => { throw new Error("unexpected probe or icon lookup"); });
  vi.stubGlobal("fetch", network);
  const factory = vi.fn(async (server) => {
    if (server.name !== "slow") throw new Error("contacted another server");
    return new Promise<never>(() => {});
  });
  const extension = createMcpExtension(factory);
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "slow" }));
  while (!factory.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(result).resolves.toMatchObject({ servers: [{ name: "slow", state: "unreachable", auth: "oauth", personalState: "connected", personalAccount: "alice@example.test" }] });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled();
  await extension.stop();
});

it("learns OAuth from a real SDK 401 without a probe or retry", async () => {
  const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const dir = await dirs.make("mcp-unauthorized-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const network = vi.fn(() => { throw new Error("unexpected probe"); });
  vi.stubGlobal("fetch", network);
  const factory = vi.fn(async () => { throw new StreamableHTTPError(401, "Unauthorized"); });
  const extension = createMcpExtension(factory);
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", state: "disconnected", personalState: "disconnected", teamState: "disconnected" }] });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled();
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote", live: "0" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", status: "pending" }] });
  await extension.stop();
});

it("preserves an expired personal grant when token refresh fails on the network", async () => {
  const dir = await dirs.make("mcp-refresh-network-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "remote", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected", account: "alice@example.test" }, { type: "personal", userId: "user-a" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) })));
  const factory = vi.fn(async () => { throw new Error("must not connect without refreshed token"); });
  const extension = createMcpExtension(factory);
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  const get = app.routes.get("GET /mcp/servers")!;
  await expect(get(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", state: "unreachable", personalState: "connected" }] });
  await expect(get(routeContext({ agent: "agent", server: "remote", live: "0" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", personalState: "connected", personalAccount: "alice@example.test" }] });
  expect(factory).not.toHaveBeenCalled();
  await extension.stop();
});

it.each(["invalid_grant", "invalid_client", "unauthorized_client"])("marks only the selected expired grant for reconnect after OAuth %s", async (error) => {
  const dir = await dirs.make("mcp-refresh-auth-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  const grant = { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" as const };
  await store.write("agent", "remote", grant, { type: "personal", userId: "user-a" });
  await store.write("agent", "remote", { ...grant, expiresAt: undefined });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
    ? Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] })
    : Response.json({ error, error_description: "Unknown credential" }, { status: 400 })));
  const extension = createMcpExtension(async () => { throw new Error("must not connect"); });
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", state: "needs_reconnect", personalState: "needs_reconnect", teamState: "connected" }] });
  await extension.stop();
});

it("includes hanging refresh in the deadline and keeps the grant after a late authentication failure", async () => {
  const dir = await dirs.make("mcp-refresh-timeout-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "remote", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" }, { type: "personal", userId: "user-a" });
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes(".well-known")) {
      // Time spent starting discovery precedes the refresh operation's own timer.
      vi.advanceTimersByTime(2_000);
      return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
    }
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  const factory = vi.fn(async () => { throw new Error("must not connect"); });
  const extension = createMcpExtension(factory);
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const get = app.routes.get("GET /mcp/servers")!;
  const result = get(routeContext({ agent: "agent", server: "remote" }));
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(8_001);
  await expect(result).resolves.toMatchObject({ servers: [{ state: "unreachable", auth: "oauth", personalState: "connected" }] });
  finish(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await new Promise((resolve) => setImmediate(resolve));
  await expect(get(routeContext({ agent: "agent", server: "remote", live: "0" }))).resolves.toMatchObject({ servers: [{ personalState: "connected" }] });
  expect(factory).not.toHaveBeenCalled();
  await extension.stop();
});

it("recognizes SDK UnauthorizedError even when its message has no status code", async () => {
  const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const dir = await dirs.make("mcp-sdk-auth-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const extension = createMcpExtension(async () => { throw new UnauthorizedError("No auth provider"); });
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", state: "disconnected" }] });
  await extension.stop();
});

it.each(["network", "timeout", "protocol", "configuration"] as const)("reports SDK %s failures through the status card", async (kind) => {
  const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
  const errors = {
    network: Object.assign(new StreamableHTTPError(503, "Unavailable"), { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) }),
    timeout: new McpError(ErrorCode.RequestTimeout, "Request timed out"),
    protocol: new McpError(ErrorCode.InvalidRequest, "Invalid protocol response"),
    configuration: Object.assign(new Error("Command missing"), { code: "ENOENT" }),
  };
  const dir = await dirs.make("mcp-sdk-errors-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const extension = createMcpExtension(async () => { throw errors[kind]; });
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ state: kind === "network" || kind === "timeout" ? "unreachable" : "disconnected", error: errors[kind].message }] });
  await extension.stop();
});

it("accepts a successful zero-tool connection and never waits for close", async () => {
  const dir = await dirs.make("mcp-empty-tools-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const network = vi.fn(() => { throw new Error("unexpected probe"); }); vi.stubGlobal("fetch", network);
  const extension = createMcpExtension(async () => ({ async listTools() { return []; }, async readResource() { return { contents: [] }; }, async callTool() {}, async close() { return new Promise<void>(() => {}); } }));
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const get = app.routes.get("GET /mcp/servers")!;
  await expect(get(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ state: "connected" }] });
  expect(network).not.toHaveBeenCalled();
  await expect(get(routeContext({ agent: "agent", server: "missing" }))).resolves.toMatchObject({ servers: [] });
  await extension.stop();
});

it("reconnects a rejected stored token when its refresh is denied, without a second connection", async () => {
  const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const dir = await dirs.make("mcp-rejected-token-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials(); const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "remote", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "rejected", refresh_token: "refresh", token_type: "Bearer" }, authorizationServerUrl: "https://auth.example.test", state: "connected" });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
    ? Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] })
    : Response.json({ error: "invalid_grant" }, { status: 400 })));
  const factory = vi.fn(async () => { throw new StreamableHTTPError(401, "Unauthorized"); });
  const extension = createMcpExtension(factory);
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  await expect(app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }))).resolves.toMatchObject({ servers: [{ auth: "oauth", state: "needs_reconnect", teamState: "needs_reconnect" }] });
  expect(factory).toHaveBeenCalledTimes(1);
  await extension.stop();
});

it("preserves a real SDK protocol error when transport cleanup hangs", async () => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const dir = await dirs.make("mcp-cleanup-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid protocol response", { status: 400 })));
  const close = vi.spyOn(StreamableHTTPClientTransport.prototype, "close").mockImplementation(() => new Promise<void>(() => {}));
  const extension = createMcpExtension();
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }));
  while (!close.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(result).resolves.toMatchObject({ servers: [{ state: "disconnected", error: expect.stringContaining("Invalid protocol response") }] });
  close.mockRestore();
  await extension.stop();
});

it("does not start tool discovery when connection finishes after the whole status deadline", async () => {
  const dir = await dirs.make("mcp-late-connect-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials(); const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "remote", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" });
  let refresh!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
    ? Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] })
    : new Promise<Response>((resolve) => { refresh = resolve; })));
  const list = vi.fn(async () => []);
  const handle = { listTools: list, async readResource() { return { contents: [] }; }, async callTool() {}, async close() {} };
  let connected!: (client: typeof handle) => void;
  const extension = createMcpExtension(async () => new Promise<typeof handle>((resolve) => { connected = resolve; }));
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }));
  while (!refresh) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(8_000);
  refresh(Response.json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 }));
  while (!connected) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(2_001);
  await expect(result).resolves.toMatchObject({ servers: [{ state: "unreachable", auth: "oauth", teamState: "connected" }] });
  connected(handle);
  await new Promise((resolve) => setImmediate(resolve));
  expect(list).not.toHaveBeenCalled();
  await extension.stop();
});

it("lists enabled and disabled catalog cards and legacy grants without network calls", async () => {
  const dir = await dirs.make("mcp-fast-shared-");
  const agentDir = path.join(dir, "agent"); await fs.mkdir(agentDir);
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
    enabled: { url: "https://enabled.example.test/mcp", displayName: "Team server", description: "Shared description", oauth: { clientId: "client" } },
    disabled: { url: "https://disabled.example.test/mcp", serverTitle: "Saved server title", oauth: { clientId: "client" } },
  } }));
  await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { legacy: { url: "https://legacy.example.test/mcp" } }, sharedServers: ["enabled"] }));
  const legacyDir = path.join(dir, "mcp/oauth", crypto.createHash("sha256").update("agent").digest("hex"));
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, `${crypto.createHash("sha256").update("legacy").digest("hex")}.json`), JSON.stringify({ connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "legacy", token_type: "Bearer" }, authorizationServerUrl: "https://auth.example.test", account: "legacy@example.test" }));
  const network = vi.fn(() => { throw new Error("unexpected network"); }); vi.stubGlobal("fetch", network);
  const extension = createMcpExtension(network);
  await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: agentDir }) });
  const app = routeApp(); extension.registerRoutes(app);
  const get = app.routes.get("GET /mcp/servers")!;
  await expect(get(routeContext({ agent: "agent", live: "0" }))).resolves.toMatchObject({ servers: [
    { name: "legacy", auth: "oauth", state: "disconnected", status: "pending", teamState: "connected", teamAccount: "legacy@example.test" },
    { name: "enabled", title: "Team server", description: "Shared description", shared: true, enabled: true, auth: "oauth", state: "disconnected", status: "pending" },
    { name: "disabled", title: "Saved server title", shared: true, enabled: false, auth: "oauth", state: "disconnected", status: "pending" },
  ] });
  await expect(get(routeContext({ agent: "agent", server: "disabled" }))).resolves.toMatchObject({ servers: [{ shared: true, enabled: false, auth: "oauth", state: "disconnected" }] });
  expect(network).not.toHaveBeenCalled();
  await extension.stop();
});

it("does not refresh tokens when OAuth metadata arrives after the status deadline", async () => {
  const dir = await dirs.make("mcp-late-metadata-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
  const host = credentials(); const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "remote", { connectedAt: "2026-01-01T00:00:00Z", client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" });
  let metadata!: (response: Response) => void;
  const token = vi.fn(async () => Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", token_type: "Bearer" }));
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
    ? new Promise<Response>((resolve) => { metadata = resolve; }) : token()));
  const extension = createMcpExtension(async () => { throw new Error("must not connect"); });
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => ({ id: "agent", workspaceDir: dir }) });
  const app = routeApp(); extension.registerRoutes(app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = app.routes.get("GET /mcp/servers")!(routeContext({ agent: "agent", server: "remote" }));
  while (!metadata) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(result).resolves.toMatchObject({ servers: [{ state: "unreachable", teamState: "connected" }] });
  metadata(Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] }));
  await new Promise((resolve) => setImmediate(resolve));
  expect(token).not.toHaveBeenCalled();
  await extension.stop();
});
