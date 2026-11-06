import { afterEach, describe, expect, it, vi } from "vitest";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

vi.mock("../account.js", () => ({ resolveAccountLabel: vi.fn().mockResolvedValue(undefined) }));

const dirs = tempDirs();
const callback = "https://yoplai.example.com/api/mcp/oauth/callback";
const documentUrl = "https://yoplai.example.com/api/mcp/oauth/client-metadata.json";
const serverUrl = "https://mcp.example.test/mcp";

afterEach(async () => {
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  await dirs.cleanup();
});

function authServer(metadata: Record<string, unknown> = {}) {
  return {
    discoverOAuthServerInfo: vi.fn().mockResolvedValue({
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
        client_id_metadata_document_supported: true,
        ...metadata,
      },
      resourceMetadata: { scopes_supported: ["tools:read"] },
    }),
    registerClient: vi.fn().mockResolvedValue({ client_id: "registered", redirect_uris: [callback] }),
    startAuthorization: vi.fn().mockResolvedValue({ authorizationUrl: new URL("https://auth.example.test/authorize"), codeVerifier: "verifier" }),
    exchangeAuthorization: vi.fn().mockResolvedValue({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" }),
    refreshAuthorization: vi.fn(),
  };
}

describe("MCP OAuth client metadata documents", () => {
  it("prefers the public document to registration when advertised", async () => {
    const sdk = authServer();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), callback, credentials(), undefined, documentUrl);

    const flow = await store.begin("assistant", "tools", serverUrl);

    expect(sdk.registerClient).not.toHaveBeenCalled();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({
      clientInformation: { client_id: documentUrl, redirect_uris: [callback], token_endpoint_auth_method: "none" },
      scope: "tools:read", resource: new URL(serverUrl),
    }));
    expect(new URL(flow.authorizationUrl).searchParams.has("prompt")).toBe(false);
    expect(new URL(flow.authorizationUrl).searchParams.has("access_type")).toBe(false);
  });

  it("uses the current document after a CIMD grant needs reconnect on a new host", async () => {
    const sdk = authServer();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const host = credentials();
    const dir = await dirs.make("mcp-cimd-");
    const original = new McpOAuthStore(dir, callback, host, undefined, documentUrl);
    const flow = await original.begin("assistant", "tools", serverUrl);
    await original.finish(flow.state, "code");
    await original.markNeedsReconnect("assistant", "tools");
    const changed = new McpOAuthStore(dir, "https://new.example.com/api/mcp/oauth/callback", host, undefined, "https://new.example.com/api/mcp/oauth/client-metadata.json");

    await changed.begin("assistant", "tools", serverUrl);

    expect(sdk.startAuthorization).toHaveBeenLastCalledWith("https://auth.example.test", expect.objectContaining({
      clientInformation: { client_id: "https://new.example.com/api/mcp/oauth/client-metadata.json", redirect_uris: ["https://new.example.com/api/mcp/oauth/callback"], token_endpoint_auth_method: "none" },
    }));
    expect(sdk.registerClient).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unadvertised CIMD", origin: "https://yoplai.example.com", advertised: false, expected: "registered" },
    { name: "http gateway", origin: "http://yoplai.example.com", advertised: true, expected: "registered" },
    { name: "localhost gateway", origin: "http://localhost:4000", advertised: true, expected: "registered" },
    { name: "https localhost gateway", origin: "https://localhost", advertised: true, expected: "registered" },
    { name: "https localhost subdomain", origin: "https://dev.localhost", advertised: true, expected: "registered" },
    { name: "absolute localhost name", origin: "https://localhost.", advertised: true, expected: "registered" },
    { name: "absolute localhost subdomain", origin: "https://dev.localhost.", advertised: true, expected: "registered" },
    { name: "https IPv4 loopback", origin: "https://127.22.33.44", advertised: true, expected: "registered" },
    { name: "https IPv6 loopback", origin: "https://[::1]", advertised: true, expected: "registered" },
  ])("keeps DCR for $name", async ({ origin, advertised, expected }) => {
    const sdk = authServer({ client_id_metadata_document_supported: advertised });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const { buildOAuthClientMetadata } = await import("../client-metadata.js");
    const redirect = `${origin}/api/mcp/oauth/callback`;
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), redirect, credentials(), undefined, buildOAuthClientMetadata(redirect)?.url);

    await store.begin("assistant", "tools", serverUrl);

    expect(sdk.registerClient).toHaveBeenCalledOnce();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: expect.objectContaining({ client_id: expected }) }));
  });

  it("uses a configured static client before CIMD or DCR", async () => {
    const sdk = authServer();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), callback, credentials(), undefined, documentUrl);

    const flow = await store.begin("assistant", "tools", serverUrl, { clientId: "static", clientSecret: "static-secret", scopes: ["configured:scope"] });

    expect(sdk.registerClient).not.toHaveBeenCalled();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: { client_id: "static", client_secret: "static-secret", redirect_uris: [callback] }, scope: "configured:scope" }));
    expect(new URL(flow.authorizationUrl).searchParams.get("access_type")).toBe("offline");
    expect(new URL(flow.authorizationUrl).searchParams.get("prompt")).toBe("consent");
  });

  it("connects with CIMD when registration is unavailable", async () => {
    const sdk = authServer({ registration_endpoint: undefined });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), callback, credentials(), undefined, documentUrl);

    await store.begin("assistant", "tools", serverUrl);

    expect(sdk.registerClient).not.toHaveBeenCalled();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: expect.objectContaining({ client_id: documentUrl }) }));
  });

  it("allows a public hostname beginning with 127", async () => {
    const sdk = authServer();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const { buildOAuthClientMetadata } = await import("../client-metadata.js");
    const redirect = "https://127.example.com/api/mcp/oauth/callback";
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), redirect, credentials(), undefined, buildOAuthClientMetadata(redirect)?.url);

    await store.begin("assistant", "tools", serverUrl);

    expect(sdk.registerClient).not.toHaveBeenCalled();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: expect.objectContaining({ client_id: "https://127.example.com/api/mcp/oauth/client-metadata.json" }) }));
  });

  it.each(["registered", "https://registration.example.test/clients/123"])("reuses an existing DCR client %s when CIMD becomes advertised", async (clientId) => {
    const sdk = authServer();
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), callback, credentials(), undefined, documentUrl);
    await store.write("assistant", "tools", {
      client: { client_id: clientId, redirect_uris: [callback] },
      tokens: { access_token: "old", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "needs_reconnect",
    });

    await store.begin("assistant", "tools", serverUrl);

    expect(sdk.registerClient).not.toHaveBeenCalled();
    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: { client_id: clientId, redirect_uris: [callback] } }));
  });

  it.each([
    { name: "the document becomes unavailable", available: false, advertised: true, staticClient: undefined, expected: "registered" },
    { name: "the authorization server withdraws CIMD", available: true, advertised: false, staticClient: undefined, expected: "registered" },
    { name: "a static client is configured", available: true, advertised: true, staticClient: { clientId: "static" }, expected: "static" },
  ])("reselects a marked CIMD client when $name", async ({ available, advertised, staticClient, expected }) => {
    const sdk = authServer({ client_id_metadata_document_supported: advertised });
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
    const { McpOAuthStore } = await import("../oauth.js");
    const store = new McpOAuthStore(await dirs.make("mcp-cimd-"), available ? callback : "http://localhost:4000/api/mcp/oauth/callback", credentials(), undefined, available ? documentUrl : undefined);
    await store.write("assistant", "tools", {
      client: { client_id: documentUrl, redirect_uris: [callback], token_endpoint_auth_method: "none" }, clientSource: "cimd",
      tokens: { access_token: "old", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "needs_reconnect",
    });

    const flow = await store.begin("assistant", "tools", serverUrl, staticClient);
    await store.finish(flow.state, "code");

    expect(sdk.startAuthorization).toHaveBeenCalledWith("https://auth.example.test", expect.objectContaining({ clientInformation: expect.objectContaining({ client_id: expected }) }));
    expect(sdk.registerClient).toHaveBeenCalledTimes(expected === "registered" ? 1 : 0);
    expect((await store.read("assistant", "tools"))?.clientSource).toBeUndefined();
  });
});
