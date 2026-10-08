import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
function connection(token: string): OAuthConnection {
  return { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" };
}
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-requester-")); dirs.push(dir); return dir; }
describe("MCP requester isolation", () => {
  it("uses executor identity instead of discovery identity, including revoked personal credentials", async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://claap.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://claap.example.test/mcp", clientId: "client" }));
    await store.write("casey", "claap", connection("A"), { type: "personal", userId: "A" });
    const calls = vi.fn((token: string | undefined) => token);
    const extension = createMcpExtension(async (server, token) => ({
      async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: { type: "object" } }]; },
      async callTool() { return calls(token); }, async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir, extensions: { mcp: { enabled: true } } };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    try {
      const tools = await extension.getAgentTools(agent, { userId: "A", config: {} });
      const tool = tools.find((entry) => entry.name === "mcp__claap__data");
      expect(tool).toBeDefined();
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("A");
      await expect(tool!.execute({}, { userId: "B" })).resolves.toMatchObject({ connected: false, authorizeUrl: "/agents/casey/edit" });
      await expect(tool!.execute({})).resolves.toMatchObject({ connected: false });
      expect(calls.mock.calls).toEqual([["A"]]);
      await store.write("casey", "claap", connection("team"));
      await expect(tool!.execute({}, { userId: "B" })).resolves.toBe("team");
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("A");
      await store.delete("casey", "claap", { type: "personal", userId: "A" });
      await expect(tool!.execute({}, { userId: "A" })).resolves.toBe("team");
    } finally { await extension.stop(); }
  });
  it("bounds a hanging personal refresh and leaves team credentials usable", async () => {
    const store = new McpOAuthStore(await directory(), "http://localhost/callback", credentials());
    await store.write("casey", "claap", connection("team"));
    await store.write("casey", "claap", { ...connection("A"), tokens: { access_token: "A", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z" }, { type: "personal", userId: "A" });
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>(() => {}); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const refresh = store.accessToken("casey", "claap", 60_000, "A");
    await fetching;
    await expect(store.accessToken("casey", "claap", 60_000, "B")).resolves.toBe("team");
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(refresh).resolves.toBeUndefined();
    await expect(store.read("casey", "claap", { type: "personal", userId: "A" })).resolves.toMatchObject({ state: "needs_reconnect" });
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ state: "connected" });
  });
  it.each(["delete", "reconnect"] as const)("does not overwrite a credential after %s during refresh", async (action) => {
    const store = new McpOAuthStore(await directory(), "http://localhost/callback", credentials());
    const scope = { type: "personal" as const, userId: "A" };
    await store.write("casey", "claap", { ...connection("A"), tokens: { access_token: "A", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z" }, scope);
    let started!: () => void;
    let finish!: (response: Response) => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const refresh = store.accessToken("casey", "claap", 60_000, "A");
    await fetching;
    if (action === "delete") await store.delete("casey", "claap", scope);
    else await store.write("casey", "claap", connection("new"), scope);
    finish(Response.json({ access_token: "late", token_type: "Bearer", expires_in: 3600 }));
    await expect(refresh).resolves.toBeUndefined();
    if (action === "delete") await expect(store.read("casey", "claap", scope)).resolves.toBeUndefined();
    else await expect(store.read("casey", "claap", scope)).resolves.toMatchObject({ tokens: { access_token: "new" }, state: "connected" });
  });

});
