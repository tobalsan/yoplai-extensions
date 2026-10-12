import { afterEach, describe, expect, it } from "vitest";

import { createMcpExtension } from "../index.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const ctx = (authenticated: boolean, query: Record<string, string>) =>
  routeContext(query, authenticated ? { user: { id: "u1", role: "superadmin" } } : {});

describe("MCP routes with multi-user enabled", () => {
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
