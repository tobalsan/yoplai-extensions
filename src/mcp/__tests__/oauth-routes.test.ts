import { credentials } from "./credentials.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";

let hostCredentials = credentials();
const dirs: string[] = [];
afterEach(async () => { hostCredentials = credentials(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js"); vi.resetModules(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function app() {
  const routes = new Map<string, (c: any) => Promise<unknown>>();
  return { routes, get(path: string, handler: (c: any) => Promise<unknown>) { routes.set(`GET ${path}`, handler); }, post(path: string, handler: (c: any) => Promise<unknown>) { routes.set(`POST ${path}`, handler); } };
}

function context(query: Record<string, string>) {
  return { get: () => ({ user: { id: "user-a", email: "user@example.test" }, impersonator: { id: "admin-a" } }), req: { query: (name: string) => name === "scope" ? (query[name] ?? "team") : query[name] }, json: (body: unknown) => body, text: (body: string, status?: number) => ({ body, status }), html: (body: string, status?: number) => ({ body, status }), redirect: (url: string) => ({ redirect: url }) };
}

describe("MCP OAuth routes", () => {
  it("allows single-user team access while personal and multi-user scopes require identity", async () => {
    const extension = createMcpExtension();
    let multiUser = false;
    await extension.start({ credentials: hostCredentials, getDataDir: () => process.cwd(), getConfig: () => ({ extensions: { multiUser: { enabled: multiUser } } }), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    const anonymous = (scope: string) => ({ ...context({ scope }), get: () => undefined });
    await expect(routes.routes.get("GET /mcp/oauth/status")!(anonymous("team"))).resolves.toEqual({ servers: [] });
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(anonymous("team"))).resolves.toEqual({ ok: true });
    await expect(routes.routes.get("GET /mcp/oauth/status")!(anonymous("personal"))).resolves.toMatchObject({ status: 400 });
    multiUser = true;
    await expect(routes.routes.get("GET /mcp/oauth/status")!(anonymous("team"))).resolves.toMatchObject({ status: 400 });
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(anonymous("team"))).resolves.toMatchObject({ status: 400 });
  });
  it("keeps team connections read-only for non-admins", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => work, getConfig: () => ({ extensions: { multiUser: { enabled: true } } }), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    const as = (role: string, query: Record<string, string>) => ({ ...context(query), get: () => ({ user: { id: "user-a", role } }) });
    const member = { agent: "casey", server: "claap", scope: "team" };

    await expect(routes.routes.get("GET /mcp/oauth/authorize")!(as("user", member))).resolves.toMatchObject({ status: 403 });
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(as("user", member))).resolves.toMatchObject({ status: 403 });
    await expect(routes.routes.get("GET /mcp/oauth/status")!(as("user", { agent: "casey" }))).resolves.toMatchObject({ canConfigureTeam: false });
    await expect(routes.routes.get("POST /mcp/servers/remove")!(as("user", member))).resolves.toMatchObject({ status: 403 });
    await expect(routes.routes.get("GET /mcp/oauth/authorize")!(as("admin", member))).resolves.not.toMatchObject({ status: 403 });
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(as("admin", member))).resolves.toEqual({ ok: true });
    await expect(routes.routes.get("GET /mcp/oauth/status")!(as("admin", { agent: "casey" }))).resolves.toMatchObject({ canConfigureTeam: true });
  });

  it("reports 401 URL-only servers as disconnected OAuth and excludes stdio", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" }, static: { url: "https://static.test/mcp", headers: { Authorization: "Bearer key" } }, local: { command: "node" } } }));
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/status")!(context({ agent: "casey" }))).resolves.toEqual({ servers: [
      { name: "claap", url: "https://api.claap.io/mcp", auth: "oauth", state: "disconnected" },
      { name: "static", url: "https://static.test/mcp", auth: "static", state: "static" },
    ], canConfigureTeam: true });
    expect(fetchMock).toHaveBeenCalledWith("https://api.claap.io/mcp", expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalledWith("https://static.test/mcp", expect.any(Object));
  });

  it("loads OAuth status from the merged root config path", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    const configPath = path.join(work, "root-mcp.json");
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { rooted: { url: "https://root.test/mcp", headers: { Authorization: "Bearer key" } } } }));
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials,
      getDataDir: () => work,
      getConfig: () => ({ extensions: { mcp: { configPath } } }),
      getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }),
    });
    const routes = app(); extension.registerRoutes(routes);

    await expect(routes.routes.get("GET /mcp/oauth/status")!(context({ agent: "casey" }))).resolves.toEqual({ servers: [
      { name: "rooted", url: "https://root.test/mcp", auth: "static", state: "static" },
    ], canConfigureTeam: true });
  });

  it("returns an HTML failure page for invalid callback state", async () => {
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => process.cwd(), getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: "missing" }))).resolves.toMatchObject({ status: 400, body: expect.stringContaining('success:false') });
  });

  it("runs authorize, callback, and status against an OAuth MCP server", async () => {
    const exchange = vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    const discover = vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } });
    const redirectUri = "https://yoplai.example.com/api/mcp/oauth/callback";
    vi.stubEnv("BASE_URL", "https://yoplai.example.com/");
    const register = vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: [redirectUri] });
    const authorize = vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.test/authorize?code_challenge=challenge&state=${options.state}`), codeVerifier: "verifier" }));
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: discover,
      registerClient: register,
      startAuthorization: authorize,
      exchangeAuthorization: exchange,
      refreshAuthorization: vi.fn(),
      discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { createMcpExtension: createExtension } = await import("../index.js");
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    const rootConfigPath = path.join(work, "root-mcp.json");
    const agentConfigPath = path.join(work, "agent-mcp.json");
    await fs.writeFile(rootConfigPath, JSON.stringify({ mcpServers: { wrong: { url: "https://wrong.test/mcp" } } }));
    await fs.writeFile(agentConfigPath, JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } }));
    const extension = createExtension();
    const record = vi.fn();
    await extension.start({ audit: { record }, credentials: hostCredentials,
      getDataDir: () => work,
      getConfig: () => ({ extensions: { mcp: { configPath: rootConfigPath } } }),
      getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true, configPath: agentConfigPath } } }),
    });
    const routes = app(); extension.registerRoutes(routes);

    const authorization = await routes.routes.get("GET /mcp/oauth/authorize")!(context({ agent: "casey", server: "claap" }));
    expect(authorization).toMatchObject({ redirect: expect.stringContaining("https://auth.test/authorize?code_challenge=challenge") });
    const state = new URL((authorization as { redirect: string }).redirect).searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(({ ...context({ code: "code", state: state! }), get: () => undefined }))).resolves.toMatchObject({ body: expect.stringContaining("success:true") });
    expect(record).toHaveBeenCalledExactlyOnceWith({ actorUserId: "user-a", actorEmail: "user@example.test", impersonatorUserId: "admin-a", action: "mcp.connect", agentId: "casey", targetType: "mcp", targetId: "claap", scope: "team", changes: [{ field: "credentials", secret: "set" }] });
    expect(discover).toHaveBeenCalledWith("https://api.claap.io/mcp", { fetchFn: expect.any(Function) });
    expect(register).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ clientMetadata: expect.objectContaining({ redirect_uris: [redirectUri] }) }));
    expect(authorize).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ redirectUrl: redirectUri, resource: new URL("https://api.claap.io/mcp") }));
    expect(exchange).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ authorizationCode: "code", codeVerifier: "verifier" }));
    const persisted = new McpOAuthStore(work, redirectUri, hostCredentials);
    await expect(persisted.read("casey", "claap")).resolves.toMatchObject({ client: { client_id: "client" }, tokens: { access_token: "access" }, state: "connected" });
    await expect(fs.stat(path.join(work, "mcp", "oauth"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(routes.routes.get("GET /mcp/oauth/status")!(context({ agent: "casey" }))).resolves.toMatchObject({ servers: [expect.objectContaining({ name: "claap", auth: "oauth", state: "connected" })] });
  });

  it("returns an HTML failure page for an expired callback state", async () => {
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } }),
      registerClient: vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }),
      startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn(), refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { createMcpExtension: createExtension } = await import("../index.js");
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } }));
    const extension = createExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    const authorization = await routes.routes.get("GET /mcp/oauth/authorize")!(context({ agent: "casey", server: "claap" }));
    const state = new URL((authorization as { redirect: string }).redirect).searchParams.get("state");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: state! }))).resolves.toMatchObject({ status: 400, body: expect.stringContaining("success:false") });
  });

  it("disconnects locally even when upstream revocation is unavailable", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials);
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }, tokens: { access_token: "token", token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.test" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const record = vi.fn();
    const extension = createMcpExtension();
    await extension.start({ audit: { record }, credentials: hostCredentials, getDataDir: () => dataDir, getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(context({ agent: "casey", server: "claap" }))).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledExactlyOnceWith({ actorUserId: "user-a", actorEmail: "user@example.test", impersonatorUserId: "admin-a", action: "mcp.disconnect", agentId: "casey", targetType: "mcp", targetId: "claap", scope: "team", changes: [{ field: "credentials", secret: "removed" }] });
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(context({ agent: "casey", server: "claap" }))).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(1);
    await expect(store.read("casey", "claap")).resolves.toBeUndefined();
  });

  it("keeps disconnect successful when the audit recorder fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials);
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "private-token", token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.test" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const extension = createMcpExtension();
      await extension.start({ audit: { record: () => { throw new Error("read-only"); } }, credentials: hostCredentials, getDataDir: () => dataDir, getConfig: () => ({}), getAgent: () => undefined });
      const routes = app(); extension.registerRoutes(routes);
      await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(context({ agent: "casey", server: "claap" }))).resolves.toEqual({ ok: true });
      await expect(store.read("casey", "claap")).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith("[mcp] Failed to record settings audit");
    } finally { warning.mockRestore(); }
  });

  it("returns while revocation hangs and the next requester call falls back or refuses", async () => {
    vi.useFakeTimers();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials);
    const connection = { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "team", token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.test" };
    await store.write("casey", "claap", connection);
    await store.write("casey", "claap", { ...connection, tokens: { ...connection.tokens, access_token: "personal" } }, { type: "personal", userId: "user-a" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => dataDir, getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(context({ agent: "casey", server: "claap", scope: "personal" }))).resolves.toEqual({ ok: true });
    await expect(store.accessToken("casey", "claap", 60_000, "user-a")).resolves.toBe("team");
    await store.delete("casey", "claap");
    await expect(store.accessToken("casey", "claap", 60_000, "user-a")).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_001);
  });
});

describe("resolveOAuthRedirectUri", () => {
  it("prefers BASE_URL, then server.baseUrl, then localhost", async () => {
    const { resolveOAuthRedirectUri } = await import("../index.js");
    vi.stubEnv("BASE_URL", "");
    expect(resolveOAuthRedirectUri({})).toBe("http://localhost:4000/api/mcp/oauth/callback");
    expect(resolveOAuthRedirectUri({ server: { baseUrl: "https://host.ts.net/" } })).toBe("https://host.ts.net/api/mcp/oauth/callback");
    expect(resolveOAuthRedirectUri({ env: { BASE_URL: "https://env.test" }, server: { baseUrl: "https://host.ts.net" } })).toBe("https://env.test/api/mcp/oauth/callback");
    vi.stubEnv("BASE_URL", "https://public.test/");
    expect(resolveOAuthRedirectUri({ server: { baseUrl: "https://host.ts.net" } })).toBe("https://public.test/api/mcp/oauth/callback");
  });
});
