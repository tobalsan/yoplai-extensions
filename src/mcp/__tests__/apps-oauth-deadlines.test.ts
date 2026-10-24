import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await dirs.cleanup(); });

describe("MCP Apps OAuth recovery deadline", () => {
  it.each(["read", "call"])("reports not_connected when %s first discovers authentication without a grant", async (operation) => {
    const dir = await dirs.make("mcp-app-late-auth-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
    vi.stubGlobal("fetch", async (url: string | URL | Request) => new Response("", { status: String(url).includes(".well-known") ? 404 : 200 }));
    const extension = createMcpExtension(async (server) => ({
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: {}, visibility: ["model", "app"] }]; },
      async callTool() { throw new Error("401 Unauthorized"); },
      async readResource() { throw new Error("401 Unauthorized"); },
      async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: credentials(), getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    try {
      const pending = operation === "call" ? extension.mcpApps.callTool({ agentId: "casey" }, "remote", "data", {}) : extension.mcpApps.readResource({ agentId: "casey" }, "remote", "ui://remote/view");
      await expect(pending).rejects.toMatchObject({ name: "McpAppsError", reason: "not_connected", authorizeUrl: "/agents/casey/edit" });
    } finally { await extension.stop(); }
  });

  it.each([ ["call", "timeout"], ["call", "aborted"], ["read", "timeout"], ["read", "aborted"] ] as const)("bounds %s auth recovery with %s and permits a later call", async (operation, reason) => {
    const dir = await dirs.make("mcp-app-recovery-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
    await store.write("casey", "remote", { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: "fake", refresh_token: "fake-refresh", token_type: "Bearer" }, connectedAt: "2026-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test", state: "connected" }, { type: "personal", userId: "viewer" });
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (value: Response) => void;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => { urls.push(String(url)); entered(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let hanging = true;
    const calls: string[] = [];
    const extension = createMcpExtension(async (server) => ({
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: {}, visibility: ["model", "app"] }]; },
      async readResource() { calls.push("read"); if (hanging) throw new Error("401 Unauthorized"); return { contents: [{ uri: "ui://remote/view", text: "healthy" }] }; },
      async callTool() { calls.push("call"); if (hanging) throw new Error("401 Unauthorized"); return { content: [{ type: "text", text: "healthy" }] }; },
      async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const ctx = { agentId: "casey", userId: "viewer", signal: controller.signal };
      const pending = operation === "call" ? extension.mcpApps.callTool(ctx, "remote", "data", {}) : extension.mcpApps.readResource(ctx, "remote", "ui://remote/view");
      const rejected = expect(pending).rejects.toMatchObject({ name: "McpAppsError", reason });
      await fetching;
      if (reason === "aborted") controller.abort();
      else {
        let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync((operation === "call" ? 25_000 : 10_000) - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await rejected;
      finish(Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(urls).toEqual(["https://auth.example.test/.well-known/oauth-authorization-server"]);
      expect(calls).toEqual([operation]);
      hanging = false;
      await expect(extension.mcpApps.callTool({ agentId: "casey", userId: "viewer" }, "remote", "data", {})).resolves.toEqual({ content: [{ type: "text", text: "healthy" }] });
    } finally { await extension.stop(); }
  });
});
