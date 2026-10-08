import { credentials } from "./credentials.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let hostCredentials = credentials();
const dirs: string[] = [];
afterEach(async () => { hostCredentials = credentials();
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("MCP OAuth flow", () => {
  it("discovers, registers, exchanges PKCE, and persists the connection", async () => {
    const exchange = vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token" } }),
      registerClient: vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: ["http://gateway.test/api/mcp/oauth/callback"] }),
      startAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: new URL("https://auth.test/authorize?code_challenge=challenge"), codeVerifier: "verifier" }),
      exchangeAuthorization: exchange,
      refreshAuthorization: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/api/mcp/oauth/callback", hostCredentials);
    const started = await store.begin("casey", "claap", "https://api.claap.io/mcp");
    await store.finish(started.state, "code");

    expect(exchange).toHaveBeenCalledWith("https://auth.test", expect.objectContaining({ authorizationCode: "code", codeVerifier: "verifier" }));
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ tokens: { access_token: "access" }, state: "connected" });
    const notified = await store.begin("casey", "claap", "https://api.claap.io/mcp", undefined, { type: "personal", userId: "user-a" }, async () => { throw new Error("notification failed"); }, { actorUserId: "user-a", actorEmail: "user@example.test" });
    const onConnected = vi.fn();
    await expect(store.finish(notified.state, "code", onConnected)).rejects.toThrow("notification failed");
    expect(onConnected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent: "casey", server: "claap", scope: { type: "personal", userId: "user-a" }, actor: { actorUserId: "user-a", actorEmail: "user@example.test" } }));
  });

  it("uses a pre-registered client when the server lacks dynamic registration", async () => {
    const register = vi.fn();
    const start = vi.fn().mockResolvedValue({ authorizationUrl: new URL("https://accounts.test/auth"), codeVerifier: "verifier" });
    const exchange = vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://accounts.test", authorizationServerMetadata: { authorization_endpoint: "https://accounts.test/auth", token_endpoint: "https://accounts.test/token" } }),
      registerClient: register,
      startAuthorization: start,
      exchangeAuthorization: exchange,
      refreshAuthorization: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials);
    const started = await store.begin("connie", "gmail", "https://gmail.test/mcp", { clientId: "cid", clientSecret: "secret", scopes: ["a", "b"] });
    await store.finish(started.state, "code");

    expect(register).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith("https://accounts.test", expect.objectContaining({ scope: "a b", clientInformation: expect.objectContaining({ client_id: "cid", client_secret: "secret" }) }));
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(exchange).toHaveBeenCalledWith("https://accounts.test", expect.objectContaining({ clientInformation: expect.objectContaining({ client_id: "cid" }) }));
  });

  const googleServer = (resourceMetadata?: unknown) => ({
    discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://accounts.google.com/", authorizationServerMetadata: { issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/auth", token_endpoint: "https://oauth2.googleapis.com/token" }, resourceMetadata }),
    registerClient: vi.fn(),
    startAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: new URL("https://accounts.google.com/auth"), codeVerifier: "verifier" }),
    exchangeAuthorization: vi.fn(),
    refreshAuthorization: vi.fn(),
  });

  it("uses the host OAuth provider matching the issuer and resource scopes when registration is unavailable", async () => {
    const mocks = googleServer({ resource: "https://calendarmcp.googleapis.com/mcp/v1", authorization_servers: ["https://accounts.google.com/"], scopes_supported: ["cal.read", "cal.write"] });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => mocks);
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials, undefined, () => ({ google: { clientId: "gid", clientSecret: "gsecret" } }));
    const started = await store.begin("connie", "calendar", "https://calendarmcp.googleapis.com/mcp/v1");
    expect(mocks.registerClient).not.toHaveBeenCalled();
    expect(mocks.startAuthorization).toHaveBeenCalledWith("https://accounts.google.com/", expect.objectContaining({ scope: "cal.read cal.write", clientInformation: expect.objectContaining({ client_id: "gid", client_secret: "gsecret" }) }));
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("prefers per-server scopes over resource scopes with a host provider", async () => {
    const mocks = googleServer({ resource: "r", authorization_servers: ["https://accounts.google.com/"], scopes_supported: ["cal.read"] });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => mocks);
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials, undefined, () => ({ google: { clientId: "gid" } }));
    await store.begin("connie", "calendar", "https://calendarmcp.googleapis.com/mcp/v1", { clientId: "own", scopes: ["mine"] });
    expect(mocks.startAuthorization).toHaveBeenCalledWith("https://accounts.google.com/", expect.objectContaining({ scope: "mine", clientInformation: expect.objectContaining({ client_id: "own" }) }));
  });

  it("keeps a clear error when no client can be resolved", async () => {
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => googleServer());
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials, undefined, () => ({ github: { clientId: "x" } }));
    await expect(store.begin("connie", "calendar", "https://calendarmcp.googleapis.com/mcp/v1")).rejects.toThrow("dynamic client registration; set oauth.clientId in mcp.json or configure oauth.providers.google in yoplai.json");
  });

  it("coalesces concurrent refreshes for the same connection", async () => {
    type RefreshedTokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    const refreshResolvers: Array<(tokens: RefreshedTokens) => void> = [];
    const refresh = vi.fn().mockImplementation(() => new Promise<RefreshedTokens>((resolve) => {
      refreshResolvers.push(resolve);
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverAuthorizationServerMetadata: vi.fn().mockResolvedValue({ token_endpoint: "https://auth.test/token" }),
      refreshAuthorization: refresh,
      discoverOAuthServerInfo: vi.fn(),
      registerClient: vi.fn(),
      startAuthorization: vi.fn(),
      exchangeAuthorization: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials);
    await store.write("casey", "claap", {
      client: { client_id: "client", redirect_uris: ["http://gateway.test/callback"] },
      tokens: { access_token: "expired", refresh_token: "refresh-1", token_type: "Bearer" },
      connectedAt: "2026-07-22T00:00:00.000Z",
      authorizationServerUrl: "https://auth.test",
      expiresAt: "2020-01-01T00:00:00.000Z",
      state: "connected",
    });

    const first = store.accessToken("casey", "claap");
    const second = store.accessToken("casey", "claap");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const resolve of refreshResolvers) {
      resolve({ access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
    }

    await expect(Promise.all([first, second])).resolves.toEqual(["fresh", "fresh"]);
    await expect(store.read("casey", "claap")).resolves.toMatchObject({
      tokens: { access_token: "fresh", refresh_token: "refresh-2" },
      state: "connected",
    });
  });

  it("forces a refresh even when the access token has not expired", async () => {
    const refresh = vi.fn().mockResolvedValue({ access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverAuthorizationServerMetadata: vi.fn().mockResolvedValue({ token_endpoint: "https://auth.test/token" }),
      refreshAuthorization: refresh,
      discoverOAuthServerInfo: vi.fn(), registerClient: vi.fn(), startAuthorization: vi.fn(), exchangeAuthorization: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials);
    await store.write("casey", "claap", {
      client: { client_id: "client", redirect_uris: ["http://gateway.test/callback"] },
      tokens: { access_token: "still-valid", refresh_token: "refresh-1", token_type: "Bearer" },
      connectedAt: "2026-07-22T00:00:00.000Z", authorizationServerUrl: "https://auth.test",
      expiresAt: "2099-01-01T00:00:00.000Z", state: "connected",
    });

    await expect(store.refreshAccessToken("casey", "claap")).resolves.toBe("fresh");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("rejects an expired pending authorization state", async () => {
    vi.useFakeTimers();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } }),
      registerClient: vi.fn().mockResolvedValue({ client_id: "client", redirect_uris: ["http://gateway.test/callback"] }),
      startAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: new URL("https://auth.test/authorize"), codeVerifier: "verifier" }),
      exchangeAuthorization: vi.fn(), refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn(),
    }));
    const { McpOAuthStore } = await import("../oauth.js");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials);
    const started = await store.begin("casey", "claap", "https://api.claap.io/mcp");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(store.finish(started.state, "code")).rejects.toThrow("invalid or expired");
    vi.useRealTimers();
  });
});
