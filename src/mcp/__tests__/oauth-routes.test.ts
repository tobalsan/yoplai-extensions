import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/status")!(context({ agent: "casey" }))).resolves.toEqual({ servers: [
      { name: "claap", url: "https://api.claap.io/mcp", auth: "oauth", state: "disconnected" },
      { name: "static", url: "https://static.test/mcp", auth: "static", state: "static" },
    ] });
  });

  it("returns an HTML failure page for invalid callback state", async () => {
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => process.cwd(), getConfig: () => ({}), getAgent: () => undefined });
    const routes = app(); extension.registerRoutes(routes);
    await expect(routes.routes.get("GET /mcp/oauth/callback")!(context({ code: "code", state: "missing" }))).resolves.toMatchObject({ status: 400, body: expect.stringContaining('success:false') });
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
