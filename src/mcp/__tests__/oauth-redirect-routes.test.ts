import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentials } from "./credentials.js";
import { routeApp, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => {
  vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js");
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await dirs.cleanup();
});

async function oauthRoutes(exchangeError?: string) {
  vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
    discoverOAuthServerInfo: async () => ({ authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { registration_endpoint: "https://auth.test/register" } }),
    registerClient: async () => ({ client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }),
    startAuthorization: async (_url: unknown, options: { state: string }) => ({ authorizationUrl: new URL(`https://auth.test/authorize?state=${options.state}`), codeVerifier: "verifier" }),
    exchangeAuthorization: async () => {
      if (exchangeError) throw new Error(exchangeError);
      return { access_token: "access", token_type: "Bearer", id_token: `header.${Buffer.from(JSON.stringify({ email: "me@example.test" })).toString("base64url")}.signature` };
    },
    refreshAuthorization: vi.fn(),
    discoverAuthorizationServerMetadata: async () => undefined,
  }));
  const { createMcpExtension } = await import("../index.js");
  const work = await dirs.make("mcp-oauth-redirect-");
  await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { calendar: { url: "https://calendar.test/mcp" } } }));
  const extension = createMcpExtension();
  await extension.start({ credentials: credentials(), getDataDir: () => work, getConfig: () => ({ extensions: { multiUser: { enabled: true } } }), getAgent: () => ({ id: "casey", workspace: work }) });
  const app = routeApp();
  extension.registerRoutes(app);
  return async (route: string, query: Record<string, string>, body?: unknown): Promise<Response> => app.routes.get(route)!({
    get: () => ({ user: { id: "user-a", role: "admin" } }),
    req: { query: (key: string) => query[key], json: async () => body },
    json: (value: unknown) => Response.json(value),
    text: (value: string, status = 200) => new Response(value, { status }),
    html: (value: string, status = 200) => new Response(value, { status }),
    redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
  });
}

describe("MCP OAuth return redirects", () => {
  it("returns a successful personal connection to its page with its query and hash", async () => {
    const request = await oauthRoutes();
    const authorization = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", scope: "personal", returnTo: "/agents/casey/mcp/calendar?view=tools#settings" });
    const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
    const callback = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/agents/casey/mcp/calendar?view=tools&oauth=connected&oauth_scope=personal#settings");
  });

  it("returns a provider denial to the team page and consumes the state once", async () => {
    const request = await oauthRoutes();
    const authorization = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", scope: "team", returnTo: "/agents/casey/edit" });
    const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
    const callback = await request("GET /mcp/oauth/callback", { error: "access_denied", state });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/agents/casey/edit?oauth=error&oauth_scope=team&oauth_error=OAuth+connection+failed%3A+access_denied");
    const replay = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("OAuth state is invalid or expired");
  });

  it("returns an exchange failure to its page and prevents a second exchange", async () => {
    const request = await oauthRoutes("Token exchange unavailable");
    const authorization = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", scope: "personal", returnTo: "/connections?agent=casey#google" });
    const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
    const callback = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/connections?agent=casey&oauth=error&oauth_scope=personal&oauth_error=Token+exchange+unavailable#google");
    const replay = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("OAuth state is invalid or expired");
  });

  it("keeps the return page through both scope-picker choices", async () => {
    const request = await oauthRoutes();
    const picker = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", returnTo: "/connections?agent=casey#settings" });
    const page = await picker.text();
    expect(page).toContain("Just me");
    expect(page).toContain("Whole team");
    const choices = Array.from(page.matchAll(/href="([^"]+)"/g), ([, href]) => new URL(href!, "http://localhost"));
    expect(choices.map((link) => link.searchParams.get("scope"))).toEqual(["personal", "team"]);
    for (const link of choices) {
      const authorization = await request("GET /mcp/oauth/authorize", Object.fromEntries(link.searchParams));
      const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
      const callback = await request("GET /mcp/oauth/callback", { code: "code", state });
      expect(callback.status).toBe(302);
      const location = new URL(callback.headers.get("Location")!, "http://localhost");
      expect(location.pathname).toBe("/connections");
      expect(location.searchParams.get("agent")).toBe("casey");
      expect(location.searchParams.get("oauth_scope")).toBe(link.searchParams.get("scope"));
      expect(location.hash).toBe("#settings");
    }
  });

  it("returns to Edit Agent after adding and authorizing an MCP server", async () => {
    const request = await oauthRoutes();
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    const added = await request("POST /mcp/servers", { agent: "casey" }, { url: "https://new.test/mcp", credentialScope: "personal", returnTo: "/agents/casey/edit?section=extensions" });
    expect(added.status).toBe(200);
    const { authorizationUrl } = await added.json();
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const callback = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/agents/casey/edit?section=extensions&oauth=connected&oauth_scope=personal");
  });

  it.each([undefined, "https://evil.example/", "//evil.example", "/a/..//evil.example", "/a/%2e%2e//evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\\evil.example", "/settings\u0000", "/settings\u007f", "/settings\u0085"])("keeps the popup result for an absent or unsafe returnTo: %j", async (returnTo) => {
    const request = await oauthRoutes();
    const authorization = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", scope: "personal", ...(returnTo === undefined ? {} : { returnTo }) });
    const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
    const callback = await request("GET /mcp/oauth/callback", { code: "code", state });
    expect(callback.status).toBe(200);
    expect(callback.headers.get("Location")).toBeNull();
    expect(await callback.text()).toContain("You can close this window and return to Yoplai.");
  });

  it("keeps expired and missing flows on the popup error page", async () => {
    const request = await oauthRoutes();
    const authorization = await request("GET /mcp/oauth/authorize", { agent: "casey", server: "calendar", scope: "personal", returnTo: "/connections" });
    const state = new URL(authorization.headers.get("Location")!).searchParams.get("state")!;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    const callbacks: Record<string, string>[] = [{ code: "code", state }, { error: "access_denied", state: "missing" }];
    for (const query of callbacks) {
      const callback = await request("GET /mcp/oauth/callback", query);
      expect(callback.status).toBe(400);
      expect(callback.headers.get("Location")).toBeNull();
      expect(await callback.text()).toContain("You can close this window and return to Yoplai.");
    }
  });
});
