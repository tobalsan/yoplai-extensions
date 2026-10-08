import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentials } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-slack-connect-"));
  dirs.push(dir);
  return dir;
}

function routeContext(query: Record<string, string>) {
  return {
    req: { query: (name: string) => query[name] },
    get: () => undefined,
    json: (body: unknown) => body,
    text: (body: string, status?: number) => ({ body, status }),
    html: (body: string, status?: number) => ({ body, status }),
    redirect: (url: string) => ({ redirect: url }),
  };
}

function routeApp() {
  const routes = new Map<string, (context: any) => Promise<unknown>>();
  return {
    routes,
    get(route: string, handler: (context: any) => Promise<unknown>) { routes.set(`GET ${route}`, handler); },
    post(route: string, handler: (context: any) => Promise<unknown>) { routes.set(`POST ${route}`, handler); },
  };
}

async function configuredExtension(dir: string, host = credentials(), extra: Record<string, unknown> = {}, callTool?: (token: string | undefined) => unknown | Promise<unknown>) {
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
    claap: { url: "https://claap.example.test/mcp", oauth: { clientId: "claap-client" } },
  } }));
  const agent = { id: "agent-a", workspaceDir: dir, extensions: { mcp: { enabled: true } } };
  const extension = (await import("../index.js")).createMcpExtension(async (server, token) => ({
    async listTools() { return [{ server: server.name, name: "search", description: "Search", inputSchema: { type: "object" } }]; },
    async callTool() { return callTool ? callTool(token) : token ? { result: "ok" } : { connected: false, provider: "mcp", reason: "not_connected" }; },
    async close() {},
  }));
  await extension.start({ ...extra, credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
  return { extension, agent, host };
}

describe("MCP Slack credential connect", () => {
  it("registers the MCP connector and unregisters it on stop", async () => {
    const dir = await directory();
    const unregister = vi.fn();
    const registerOAuthConnector = vi.fn(() => unregister);
    const { extension } = await configuredExtension(dir, credentials(), {
      credentialConnect: { registerOAuthConnector, requestLink: vi.fn() },
    });

    expect(registerOAuthConnector).toHaveBeenCalledWith("mcp", expect.any(Function));
    await extension.stop();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("forwards exact execution context and the configured server id, ignoring tool params", async () => {
    const dir = await directory();
    const toolContext = { userId: "user-a", traceId: "trace-7", suppliedServer: "attacker-server" };
    const requestLink = vi.fn().mockResolvedValue("https://yoplai.example.test/connect/one-use");
    const { extension, agent } = await configuredExtension(dir, credentials(), {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    });
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const refusal = tools.find((tool) => tool.name === "mcp__claap__not_connected")!;

    await expect(refusal.execute({ server: "attacker-server" }, toolContext)).resolves.toMatchObject({
      authorizeUrl: "https://yoplai.example.test/connect/one-use",
      message: expect.stringContaining("https://yoplai.example.test/connect/one-use"),
    });
    expect(requestLink).toHaveBeenCalledWith(toolContext, {
      kind: "extension-oauth", extensionId: "mcp", targetId: "claap",
    });
    await extension.stop();
  });

  it("keeps the regular personal connect route when Slack has no active flow", async () => {
    const dir = await directory();
    const requestLink = vi.fn().mockResolvedValue(undefined);
    const { extension, agent } = await configuredExtension(dir, credentials(), {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    });
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const refusal = tools.find((tool) => tool.name === "mcp__claap__not_connected")!;

    await expect(refusal.execute({}, { userId: "user-a" })).resolves.toMatchObject({
      authorizeUrl: "/agents/agent-a/edit",
      message: expect.stringContaining("agent's extensions"),
    });
    await extension.stop();
  });

  it("does not request a Slack link without execution context", async () => {
    const dir = await directory();
    const requestLink = vi.fn();
    const { extension, agent } = await configuredExtension(dir, credentials(), {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    });
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const refusal = tools.find((tool) => tool.name === "mcp__claap__not_connected")!;

    await expect(refusal.execute({}, undefined)).resolves.toMatchObject({ authorizeUrl: "/agents/agent-a/edit" });
    expect(requestLink).not.toHaveBeenCalled();
    await extension.stop();
  });

  it("requests a personal reconnect link when the discovered tool loses its grant", async () => {
    const dir = await directory();
    const host = credentials();
    host.save({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } }, {
      client: { client_id: "personal-client", redirect_uris: [] },
      tokens: { access_token: "personal-token", token_type: "Bearer" },
      connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test",
    });
    const requestLink = vi.fn().mockResolvedValue("https://yoplai.example.test/reconnect");
    const { extension, agent } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    }, () => ({ connected: false, provider: "mcp", reason: "needs_reconnect" }));
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const search = tools.find((tool) => tool.name === "mcp__claap__search")!;
    host.delete({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } });
    const execution = { userId: "user-a", traceId: "reconnect-trace" };

    await expect(search.execute({}, execution)).resolves.toMatchObject({ authorizeUrl: "https://yoplai.example.test/reconnect" });
    expect(requestLink).toHaveBeenCalledWith(execution, { kind: "extension-oauth", extensionId: "mcp", targetId: "claap" });
    await extension.stop();
  });

  it("requests a connect link after an MCP tool returns 401", async () => {
    const dir = await directory();
    const host = credentials();
    host.save({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } }, {
      client: { client_id: "personal-client", redirect_uris: [] },
      tokens: { access_token: "personal-token", token_type: "Bearer" },
      connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test",
    });
    const requestLink = vi.fn().mockResolvedValue("https://yoplai.example.test/reconnect");
    const { extension, agent } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    }, () => { throw new Error("401 Unauthorized"); });
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const search = tools.find((tool) => tool.name === "mcp__claap__search")!;
    const execution = { userId: "user-a", traceId: "401-trace" };

    await expect(search.execute({}, execution)).resolves.toMatchObject({ authorizeUrl: "https://yoplai.example.test/reconnect" });
    expect(requestLink).toHaveBeenCalledWith(execution, { kind: "extension-oauth", extensionId: "mcp", targetId: "claap" });
    await extension.stop();
  });

  it("leaves team connections usable without requesting a personal link", async () => {
    const dir = await directory();
    const host = credentials();
    host.save({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "team" } }, {
      client: { client_id: "team-client", redirect_uris: [] },
      tokens: { access_token: "team-token", token_type: "Bearer" },
      connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test",
    });
    const requestLink = vi.fn();
    const { extension, agent } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn(() => vi.fn()), requestLink },
    });
    const tools = await extension.getAgentTools(agent, { userId: "user-a", config: {} });
    const search = tools.find((tool) => tool.name === "mcp__claap__search")!;

    await expect(search.execute({}, { userId: "user-a" })).resolves.toEqual({ result: "ok" });
    expect(requestLink).not.toHaveBeenCalled();
    await extension.stop();
  });

  it("saves personal OAuth grant before completing with the trusted target id; rejects replay and invalid targets", async () => {
    const discoverOAuthServerInfo = vi.fn().mockResolvedValue({
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" },
    });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo,
      registerClient: vi.fn(),
      startAuthorization: vi.fn().mockImplementation((_url, options) => ({
        authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier",
      })),
      exchangeAuthorization: vi.fn().mockResolvedValue({ access_token: "personal-token", token_type: "Bearer" }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dir = await directory();
    const host = credentials();
    const completion = vi.fn(async (targetId: string) => {
      expect(targetId).toBe("claap");
      expect(host.get({ agentId: "_shared", integration: "mcp-url:https://claap.example.test/mcp#claap-client", scope: { type: "personal", userId: "user-a" } })).toMatchObject({ tokens: { access_token: "personal-token" } });
    });
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    const url = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const state = new URL(url).searchParams.get("state")!;
    const routes = routeApp(); extension.registerRoutes(routes);
    await expect(oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "tampered", onComplete: completion })).rejects.toThrow("Unknown OAuth MCP server");
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(routeContext({ code: "code", state }))).resolves.toMatchObject({ body: expect.stringContaining("success:true") });
    expect(completion).toHaveBeenCalledWith("claap");
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(routeContext({ code: "code", state }))).resolves.toMatchObject({ status: 400 });
    expect(completion).toHaveBeenCalledOnce();
    const store = new McpOAuthStore(dir, "http://localhost:4000/api/mcp/oauth/callback", host, () => ({ url: "https://claap.example.test/mcp", clientId: "claap-client" }));
    await expect(store.read("agent-a", "claap", { type: "personal", userId: "user-a" })).resolves.toMatchObject({ tokens: { access_token: "personal-token" } });
    await extension.stop();
  });

  it("never completes when authorization is denied, expires, or token exchange fails", async () => {
    const exchangeAuthorization = vi.fn().mockRejectedValue(new Error("provider failure"));
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" } }),
      registerClient: vi.fn(), startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization, refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const dir = await directory();
    const completion = vi.fn();
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, credentials(), {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    const routes = routeApp(); extension.registerRoutes(routes);
    const callback = routes.routes.get("GET /mcp/oauth/callback")!;

    const deniedUrl = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const deniedState = new URL(deniedUrl).searchParams.get("state")!;
    await expect(callback(routeContext({ error: "access_denied", state: deniedState }))).resolves.toMatchObject({ status: 400 });
    await expect(callback(routeContext({ code: "code", state: deniedState }))).resolves.toMatchObject({ status: 400 });

    vi.useFakeTimers();
    const expiredUrl = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const expiredState = new URL(expiredUrl).searchParams.get("state")!;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(callback(routeContext({ code: "code", state: expiredState }))).resolves.toMatchObject({ status: 400 });
    expect(exchangeAuthorization).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
    vi.useRealTimers();

    const failingUrl = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const failingState = new URL(failingUrl).searchParams.get("state")!;
    await expect(callback(routeContext({ code: "code", state: failingState }))).resolves.toMatchObject({ status: 400 });
    expect(completion).not.toHaveBeenCalled();
    await extension.stop();
  });

  it("bounds hanging discovery and exchange calls without completing or saving a grant", async () => {
    let discoverStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { discoverStarted = resolve; });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn(async (_url, options) => {
        discoverStarted();
        await options.fetchFn("https://auth.example.test/.well-known/openid-configuration");
        return { authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" } };
      }),
      registerClient: vi.fn(), startAuthorization: vi.fn(), exchangeAuthorization: vi.fn(),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))));
    const dir = await directory();
    const host = credentials();
    const completion = vi.fn();
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    vi.useFakeTimers();
    const starting = oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const timeout = expect(starting).rejects.toThrow("timed out");
    await discoveryStarted;
    await vi.advanceTimersByTimeAsync(10_001);
    await timeout;
    expect(completion).not.toHaveBeenCalled();
    expect(host.get({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    expect(host.get({ agentId: "_shared", integration: "mcp-url:https://claap.example.test/mcp#claap-client", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    await extension.stop();
  });

  it("bounds a hanging token exchange without completing or saving a grant", async () => {
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" } }),
      registerClient: vi.fn(), startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn(async (_url, options) => {
        exchangeStarted();
        await options.fetchFn("https://auth.example.test/token");
      }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))));
    const dir = await directory();
    const host = credentials();
    const completion = vi.fn();
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    const url = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const state = new URL(url).searchParams.get("state")!;
    const routes = routeApp(); extension.registerRoutes(routes);
    vi.useFakeTimers();
    const callback = routes.routes.get("GET /mcp/oauth/callback")!(routeContext({ code: "code", state }));
    const timeout = expect(callback).resolves.toMatchObject({ status: 400 });
    await started;
    await vi.advanceTimersByTimeAsync(10_001);
    await timeout;

    expect(completion).not.toHaveBeenCalled();
    expect(host.get({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    expect(host.get({ agentId: "_shared", integration: "mcp-url:https://claap.example.test/mcp#claap-client", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    await extension.stop();
  });

  it("times out a token exchange that never receives response headers", async () => {
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" } }),
      registerClient: vi.fn(), startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn(async (_url, options) => {
        exchangeStarted();
        await options.fetchFn("https://auth.example.test/token");
      }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const dir = await directory();
    const host = credentials();
    const completion = vi.fn();
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    const url = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const state = new URL(url).searchParams.get("state")!;
    const routes = routeApp(); extension.registerRoutes(routes);
    vi.useFakeTimers();
    const callback = routes.routes.get("GET /mcp/oauth/callback")!(routeContext({ code: "code", state }));
    const timeout = expect(callback).resolves.toMatchObject({ status: 400 });
    await started;
    await vi.advanceTimersByTimeAsync(10_001);
    await timeout;

    expect(completion).not.toHaveBeenCalled();
    expect(host.get({ agentId: "agent-a", integration: "mcp:claap", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    expect(host.get({ agentId: "_shared", integration: "mcp-url:https://claap.example.test/mcp#claap-client", scope: { type: "personal", userId: "user-a" } })).toBeUndefined();
    await extension.stop();
  });

  it("retains the personal grant if Slack completion fails after OAuth succeeds", async () => {
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token" } }),
      registerClient: vi.fn(), startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn().mockResolvedValue({ access_token: "saved-token", token_type: "Bearer" }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const dir = await directory();
    const host = credentials();
    const completion = vi.fn().mockRejectedValue(new Error("Slack confirmation unavailable"));
    let oauthStart!: (options: { agentId: string; userId: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>;
    const { extension } = await configuredExtension(dir, host, {
      credentialConnect: { registerOAuthConnector: vi.fn((_id: string, start: typeof oauthStart) => { oauthStart = start; return vi.fn(); }), requestLink: vi.fn() },
    });
    const url = await oauthStart({ agentId: "agent-a", userId: "user-a", targetId: "claap", onComplete: completion });
    const state = new URL(url).searchParams.get("state")!;
    const routes = routeApp(); extension.registerRoutes(routes);

    await expect(routes.routes.get("GET /mcp/oauth/callback")!(routeContext({ code: "code", state }))).resolves.toMatchObject({ status: 400 });
    expect(completion).toHaveBeenCalledWith("claap");
    expect(host.get({ agentId: "_shared", integration: "mcp-url:https://claap.example.test/mcp#claap-client", scope: { type: "personal", userId: "user-a" } })).toMatchObject({ tokens: { access_token: "saved-token" } });
    await extension.stop();
  });
});
