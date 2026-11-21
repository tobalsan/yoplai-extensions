import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await dirs.cleanup();
});

const ctx = (authenticated: boolean, query: Record<string, string>) =>
  routeContext(query, authenticated ? { user: { id: "u1", role: "superadmin" } } : {});

describe("MCP routes with multi-user enabled", () => {
  it.each([
    ["a member", "user", false, true, false],
    ["an admin of another team", "admin", false, true, false],
    ["an admin without a management decision", "admin", undefined, true, false],
    ["an agent manager", "admin", true, true, true],
    ["a single-user operator", "user", undefined, false, true],
  ] as const)("applies shared settings permissions for %s", async (_caller, role, managesAgent, multiUser, allowed) => {
    const home = await dirs.make("mcp-management-");
    const workspace = path.join(home, "agent");
    await fs.mkdir(workspace);
    const file = path.join(workspace, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        docs: { url: "https://docs.example.test/mcp", headers: {}, yoplaiManaged: true },
        calendar: { url: "https://calendar.example.test/mcp", oauth: { clientId: "fixture" } },
      },
    }, null, 2) + "\n";
    await fs.writeFile(file, original);
    await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify({
      mcpServers: { shared: { url: "https://shared.example.test/mcp", headers: {} } },
    }));
    const fetchMcp = vi.fn(async (input: string | URL | Request) => new Response(null, {
      status: String(input).endsWith("/mcp") ? 401 : 404,
    }));
    vi.stubGlobal("fetch", fetchMcp);
    const begin = vi.spyOn(McpOAuthStore.prototype, "begin").mockResolvedValue({
      state: "fixture", authorizationUrl: "https://identity.example.test/authorize",
    });
    const factory = vi.fn(async () => ({
      async listTools() { return []; },
      async readResource() { return { contents: [] }; },
      async callTool() { return "pong"; },
      async close() {},
      getServerIcon: () => "https://docs.example.test/icon.png",
    }));
    const host = credentials();
    const grantStore = new McpOAuthStore(home, "http://localhost/callback", host, () => ({
      url: "https://calendar.example.test/mcp", clientId: "fixture",
    }));
    await grantStore.write("a1", "calendar", {
      client: { client_id: "fixture", redirect_uris: [] },
      tokens: { access_token: "fixture-grant", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z",
      authorizationServerUrl: "https://identity.example.test",
      account: "team@example.test",
    });
    const extension = createMcpExtension(factory);
    await extension.start({
      credentials: host,
      getDataDir: () => home,
      getConfig: () => ({ extensions: { multiUser: { enabled: multiUser } } }),
      getAgent: () => ({ id: "a1", workspaceDir: workspace }),
    });
    const app = routeApp();
    extension.registerRoutes(app);
    const call = (route: string, query: Record<string, string>, body?: unknown) => {
      const context = routeContext({ agent: "a1", ...query }, { user: { id: "u1", role } }, managesAgent);
      return app.routes.get(route)!({ ...context, req: { ...context.req, json: async () => body } });
    };
    try {
      for (const [route, query, body, result] of [
        ["POST /mcp/servers", {}, { url: "https://personal.example.test/mcp", credentialScope: "personal" }, { authorizationUrl: "https://identity.example.test/authorize" }],
        ["POST /mcp/servers", {}, { url: "https://team.example.test/mcp", credentialScope: "team" }, { authorizationUrl: "https://identity.example.test/authorize" }],
        ["POST /mcp/servers/shared", { server: "shared" }, { enabled: true }, { server: { enabled: true } }],
        ["POST /mcp/servers/icon/refresh", { server: "docs" }, undefined, { status: "updated" }],
        ["POST /mcp/servers/config", { server: "docs" }, { config: { url: "https://edited.example.test/mcp" } }, { editable: true }],
        ["POST /mcp/servers/remove", { server: "docs" }, undefined, { ok: true }],
        ["GET /mcp/oauth/authorize", { server: "calendar", scope: "team" }, undefined, { redirect: "https://identity.example.test/authorize" }],
        ["POST /mcp/oauth/disconnect", { server: "calendar", scope: "team" }, undefined, { ok: true }],
      ] as const) {
        const resultForCaller = await call(route, query, body);
        expect(resultForCaller, route).toMatchObject(allowed ? result : { status: 403 });
        if (!allowed) {
          expect(await fs.readFile(file, "utf8"), route).toBe(original);
          expect(factory, route).not.toHaveBeenCalled();
          expect(begin, route).not.toHaveBeenCalled();
          expect(fetchMcp, route).not.toHaveBeenCalled();
        }
      }
      expect(await call("GET /mcp/servers", { live: "0" })).toMatchObject({ canConfigureTeam: allowed });
      expect(await call("GET /mcp/oauth/status", { scope: "team" })).toMatchObject({
        servers: expect.arrayContaining([
          expect.objectContaining({ name: "calendar", state: allowed ? "disconnected" : "connected" }),
        ]),
        canConfigureTeam: allowed,
      });
      if (!allowed) {
        expect(await call("GET /mcp/oauth/authorize", { server: "calendar", scope: "personal" }))
          .toEqual({ redirect: "https://identity.example.test/authorize" });
        expect(begin).toHaveBeenCalledExactlyOnceWith(
          "a1", "calendar", "https://calendar.example.test/mcp", expect.any(Object),
          { type: "personal", userId: "u1" }, undefined, expect.any(Object), undefined,
        );
      }
    } finally {
      await extension.stop();
    }
  });

  it("answer 401 without a user and proceed with one", async () => {
    const home = await dirs.make("mcp-auth-");
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => home, getConfig: () => ({ agents: [{ id: "a1" }], extensions: { multiUser: { enabled: true } } }), getAgent: () => ({ id: "a1", workspaceDir: home }) });
    const app = routeApp();
    extension.registerRoutes(app);
    const { routes } = app;
    const query = { agent: "a1", server: "x", url: "https://x.test/mcp" };
    for (const route of ["GET /mcp/servers/personal-status", "GET /mcp/servers", "POST /mcp/servers", "POST /mcp/servers/shared", "POST /mcp/servers/label", "POST /mcp/servers/remove", "GET /mcp/servers/config", "POST /mcp/servers/config", "GET /mcp/catalog"]) {
      const handler = routes.get(route);
      if (!handler) throw new Error(`missing route ${route}`);
      expect(await handler(ctx(false, query)), route).toEqual({ body: "Authentication required", status: 401 });
      expect(await handler(ctx(true, query)), route).not.toEqual({ body: "Authentication required", status: 401 });
    }
  });
});
