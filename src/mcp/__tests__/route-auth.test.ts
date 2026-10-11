import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpExtension } from "../index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const ctx = (authenticated: boolean, query: Record<string, string>) => ({
  get: () => (authenticated ? { user: { id: "u1", role: "superadmin" } } : undefined),
  req: { query: (key: string) => query[key], json: async () => ({}) },
  json: (value: unknown) => value,
  text: (value: string, status?: number) => ({ value, status }),
  html: (value: string) => value,
  redirect: (value: string) => value,
});

describe("MCP routes with multi-user enabled", () => {
  it("answer 401 without a user and proceed with one", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-")); dirs.push(home);
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => home, getConfig: () => ({ agents: [{ id: "a1" }], extensions: { multiUser: { enabled: true } } }), getAgent: () => ({ id: "a1", workspaceDir: home }) } as never);
    const routes = new Map<string, (c: any) => Promise<any>>();
    extension.registerRoutes({ get: (p: string, h: any) => routes.set(`GET ${p}`, h), post: (p: string, h: any) => routes.set(`POST ${p}`, h) });
    const query = { agent: "a1", server: "x", url: "https://x.test/mcp" };
    for (const route of ["GET /mcp/servers/personal-status", "GET /mcp/servers", "POST /mcp/servers", "POST /mcp/servers/shared", "POST /mcp/servers/label", "POST /mcp/servers/remove", "GET /mcp/servers/config", "POST /mcp/servers/config", "GET /mcp/catalog"]) {
      const handler = routes.get(route);
      if (!handler) throw new Error(`missing route ${route}`);
      expect(await handler(ctx(false, query)), route).toEqual({ value: "Authentication required", status: 401 });
      expect(await handler(ctx(true, query)), route).not.toEqual({ value: "Authentication required", status: 401 });
    }
  });
});
