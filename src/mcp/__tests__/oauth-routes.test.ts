import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js"); vi.resetModules(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function app() {
  const routes = new Map<string, (c: any) => Promise<unknown>>();
  return { routes, get(path: string, handler: (c: any) => Promise<unknown>) { routes.set(`GET ${path}`, handler); }, post(path: string, handler: (c: any) => Promise<unknown>) { routes.set(`POST ${path}`, handler); } };
}

function context(query: Record<string, string>) {
  return { req: { query: (name: string) => query[name] }, json: (body: unknown) => body, text: (body: string, status?: number) => ({ body, status }), html: (body: string, status?: number) => ({ body, status }), redirect: (url: string) => ({ redirect: url }) };
}

describe("MCP OAuth routes", () => {
  it("reports 401 URL-only servers as disconnected OAuth and excludes stdio", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(work);
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" }, static: { url: "https://static.test/mcp", headers: { Authorization: "Bearer key" } }, local: { command: "node" } } }));
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/status")!(context({ agent: "casey" }))).resolves.toEqual({ servers: [
      { name: "claap", url: "https://api.claap.io/mcp", auth: "oauth", state: "disconnected" },
      { name: "static", url: "https://static.test/mcp", auth: "static", state: "static" },
    ] });
    expect(fetchMock).toHaveBeenCalledWith("https://api.claap.io/mcp", expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalledWith("https://static.test/mcp", expect.any(Object));
  });

  it("returns an HTML failure page for invalid callback state", async () => {
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => process.cwd(), getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: "missing" }))).resolves.toMatchObject({ status: 400, body: expect.stringContaining('success:false') });
  });

  it("runs authorize, callback, and status against an OAuth MCP server", async () => {
    const exchange = vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    const discover = vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } });
    const register = vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] });
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
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } }));
    const extension = createExtension();
    await extension.start({ getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);

    const authorization = await routes.routes.get("GET /mcp/oauth/authorize")!(context({ agent: "casey", server: "claap" }));
    expect(authorization).toMatchObject({ redirect: expect.stringContaining("https://auth.test/authorize?code_challenge=challenge") });
    const state = new URL((authorization as { redirect: string }).redirect).searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: state! }))).resolves.toMatchObject({ body: expect.stringContaining("success:true") });
    expect(discover).toHaveBeenCalledWith("https://api.claap.io/mcp");
    expect(register).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ clientMetadata: expect.objectContaining({ redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }) }));
    expect(authorize).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ redirectUrl: "http://localhost:4000/api/mcp/oauth/callback", resource: new URL("https://api.claap.io/mcp") }));
    expect(exchange).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ authorizationCode: "code", codeVerifier: "verifier" }));
    const persisted = new McpOAuthStore(work, "http://localhost:4000/api/mcp/oauth/callback");
    await expect(persisted.read("casey", "claap")).resolves.toMatchObject({ client: { client_id: "client" }, tokens: { access_token: "access" }, state: "connected" });
    const oauthRoot = path.join(work, "mcp", "oauth");
    const tokenFile = path.join(oauthRoot, (await fs.readdir(oauthRoot))[0]!, (await fs.readdir(path.join(oauthRoot, (await fs.readdir(oauthRoot))[0]!)))[0]!);
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
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
    await extension.start({ getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    const authorization = await routes.routes.get("GET /mcp/oauth/authorize")!(context({ agent: "casey", server: "claap" }));
    const state = new URL((authorization as { redirect: string }).redirect).searchParams.get("state");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: state! }))).resolves.toMatchObject({ status: 400, body: expect.stringContaining("success:false") });
  });

  it("disconnects locally even when upstream revocation is unavailable", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback");
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }, tokens: { access_token: "token", token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.test" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => dataDir, getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("POST /mcp/oauth/disconnect")!(context({ agent: "casey", server: "claap" }))).resolves.toEqual({ ok: true });
    await expect(store.read("casey", "claap")).resolves.toBeUndefined();
  });
});
