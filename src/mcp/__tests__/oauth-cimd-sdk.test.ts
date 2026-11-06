import { afterEach, describe, expect, it, vi } from "vitest";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

vi.mock("../account.js", () => ({ resolveAccountLabel: vi.fn().mockResolvedValue(undefined) }));

const dirs = tempDirs();
const callback = "https://yoplai.example.com/api/mcp/oauth/callback";
const documentUrl = "https://yoplai.example.com/api/mcp/oauth/client-metadata.json";
const serverUrl = "https://mcp.example.test/mcp";
afterEach(async () => { vi.unstubAllGlobals(); await dirs.cleanup(); });

describe("CIMD token requests through the real MCP SDK", () => {
  it.each([
    { name: "several methods including none", methods: ["client_secret_basic", "client_secret_post", "none"] },
    { name: "only secret methods", methods: ["client_secret_basic", "client_secret_post"] },
    { name: "omitted auth methods", methods: undefined },
  ])("exchanges and refreshes as a public client with $name", async ({ methods }) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://mcp.example.test/.well-known/")) return Response.json({ resource: serverUrl, authorization_servers: ["https://auth.example.test"], scopes_supported: ["tools:read"] });
      if (request.url === "https://auth.example.test/.well-known/oauth-authorization-server") return Response.json({
        issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true,
        ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}),
      });
      if (request.url === "https://auth.example.test/token") {
        requests.push(request);
        return Response.json({ access_token: requests.length === 1 ? "initial" : "refreshed", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error(`Unexpected OAuth request: ${request.method} ${request.url}`);
    });
    const dir = await dirs.make("mcp-cimd-sdk-");
    const host = credentials();
    const store = new McpOAuthStore(dir, callback, host, undefined, documentUrl);

    const flow = await store.begin("assistant", "tools", serverUrl);
    const authorization = new URL(flow.authorizationUrl);
    expect(authorization.searchParams.get("client_id")).toBe(documentUrl);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(serverUrl);
    await store.finish(flow.state, "authorization-code");
    await expect(store.accessToken("assistant", "tools")).resolves.toBe("initial");
    const changedHost = new McpOAuthStore(dir, "http://localhost:4000/api/mcp/oauth/callback", host);
    await expect(changedHost.refreshAccessToken("assistant", "tools")).resolves.toBe("refreshed");

    expect(requests).toHaveLength(2);
    const exchange = new URLSearchParams(await requests[0]!.text());
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("authorization-code");
    expect(exchange.get("redirect_uri")).toBe(callback);
    const refresh = new URLSearchParams(await requests[1]!.text());
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("refresh");
    for (const [index, body] of [exchange, refresh].entries()) {
      expect(body.get("client_id")).toBe(documentUrl);
      expect(body.has("client_secret")).toBe(false);
      expect(requests[index]!.headers.has("Authorization")).toBe(false);
    }
    await expect(store.read("assistant", "tools")).resolves.toMatchObject({ clientSource: "cimd", state: "connected", tokens: { access_token: "refreshed" } });
  });
});
