import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

const URL_A = "https://claap.example.test/mcp";
const personal = (userId: string) => ({ type: "personal" as const, userId });
function connection(token: string, state: OAuthConnection["state"] = "connected"): OAuthConnection {
  return { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state };
}
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shared-")); dirs.push(dir); return dir; }
function context(userId: string | undefined, query: Record<string, string>) {
  return {
    get: () => userId ? { user: { id: userId, role: "user" } } : {},
    req: { query: (key: string) => query[key] },
    json: (value: unknown) => value, text: (value: string, status?: number) => ({ value, status }),
  };
}

// Two agents, each with its own mcp.json.
async function setup(servers: Record<string, Record<string, { url: string }>>) {
  const host = credentials();
  const agents: Record<string, { id: string; workspaceDir: string; extensions: { mcp: { enabled: true } } }> = {};
  for (const [id, mcpServers] of Object.entries(servers)) {
    const dir = await directory();
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([name, value]) => [name, { ...value, oauth: { clientId: "client" } }])) }));
    agents[id] = { id, workspaceDir: dir, extensions: { mcp: { enabled: true } } };
  }
  const dataDir = await directory();
  const tokens = vi.fn((token: string | undefined) => token);
  const extension = createMcpExtension(async (server, token) => ({
    async listTools() { return [{ server: server.name, name: "data", description: "Data", inputSchema: { type: "object" } }]; },
    async callTool() { return tokens(token); }, async close() {},
  }));
  await extension.start({ credentials: host, getDataDir: () => dataDir, getConfig: () => ({}), getAgent: (id: string) => agents[id] });
  const routes = new Map<string, (c: unknown) => Promise<any>>();
  extension.registerRoutes({ get: (p: string, h: any) => routes.set(`GET ${p}`, h), post: (p: string, h: any) => routes.set(`POST ${p}`, h) });
  const store = new McpOAuthStore(dataDir, "http://localhost/callback", host, (agent, server) => {
    const entry = JSON.parse(JSON.stringify(Object.entries(servers[agent] ?? {}).find(([name]) => name === server)?.[1] ?? null)) as { url: string } | null;
    return entry ? { url: entry.url, clientId: "client" } : undefined;
  });
  async function state(agent: string, name: string, userId?: string) {
    const list = await routes.get("GET /mcp/servers")!(context(userId, { agent }));
    return list.servers.find((item: { name: string }) => item.name === name);
  }
  async function run(agent: string, name: string, userId?: string) {
    const tools = await extension.getAgentTools(agents[agent], { userId, config: {} });
    return (tools.find((entry) => entry.name === `mcp__${name}__data`) ?? tools.find((entry) => entry.name === `mcp__${name}__not_connected`))!.execute({}, { userId });
  }
  return { host, store, state, run, routes, extension };
}

describe("shared personal MCP grants", () => {
  it("(a) personal connection on sally is connected on cira and its token is used", async () => {
    const { store, state, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "connected" });
      await expect(run("cira", "claap", "A")).resolves.toBe("A");
    } finally { await extension.stop(); }
  });
  it("(b) different server names with the same URL share", async () => {
    const { store, state, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap_meetings: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      expect(await state("cira", "claap_meetings", "A")).toMatchObject({ personalState: "connected" });
      await expect(run("cira", "claap_meetings", "A")).resolves.toBe("A");
    } finally { await extension.stop(); }
  });
  it("(c) same name with a different URL does not share", async () => {
    const { store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: "https://other.example.test/mcp" } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "disconnected" });
    } finally { await extension.stop(); }
  });
  it("normalizes the URL when computing identity", async () => {
    const { store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: "HTTPS://Claap.Example.test:443/mcp/" } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "connected" });
    } finally { await extension.stop(); }
  });
  it("(d) team grant on sally is not visible on cira", async () => {
    const { store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("team"));
      expect(await state("sally", "claap", "A")).toMatchObject({ teamState: "connected" });
      expect(await state("cira", "claap", "A")).toMatchObject({ teamState: "disconnected" });
    } finally { await extension.stop(); }
  });
  it("(e) legacy per-agent personal grant is promoted to the shared key and removed", async () => {
    const { host, store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      const legacyKey = { agentId: "sally", integration: "mcp:claap", scope: personal("A") };
      host.save(legacyKey, connection("legacy"));
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "disconnected" });
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "connected" });
      expect(host.get(legacyKey)).toBeUndefined();
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "connected" });
      await expect(store.accessToken("cira", "claap", 60_000, "A")).resolves.toBe("legacy");
    } finally { await extension.stop(); }
  });
  it("(f) personal disconnect on cira disconnects sally and removes the legacy copy", async () => {
    const { host, store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      host.save({ agentId: "cira", integration: "mcp:claap", scope: personal("A") }, connection("legacy"));
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      await expect(store.disconnect("cira", "claap", personal("A"))).resolves.toBe(true);
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "disconnected" });
      expect(host.get({ agentId: "cira", integration: "mcp:claap", scope: personal("A") })).toBeUndefined();
    } finally { await extension.stop(); }
  });
  it("(g) another user never resolves a personal grant", async () => {
    const { store, state, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      expect(await state("cira", "claap", "B")).toMatchObject({ personalState: "disconnected" });
      await expect(run("cira", "claap", "B")).resolves.toMatchObject({ connected: false });
    } finally { await extension.stop(); }
  });
  it("(h) unattended run ignores personal grants and uses team only", async () => {
    const { store, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      await expect(run("cira", "claap")).resolves.toMatchObject({ connected: false });
      await store.write("cira", "claap", connection("team"));
      await expect(run("cira", "claap")).resolves.toBe("team");
    } finally { await extension.stop(); }
  });
  it("personal needs_reconnect does not fall back to team or another account", async () => {
    const { store, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("cira", "claap", connection("team"));
      await store.write("sally", "claap", connection("A", "needs_reconnect"), personal("A"));
      await expect(store.accessToken("cira", "claap", 60_000, "A")).resolves.toBeUndefined();
      await expect(run("cira", "claap", "B")).resolves.toBe("team");
    } finally { await extension.stop(); }
  });
  it("disconnect does not resurrect another agent's legacy personal grant; a fresh connect works again", async () => {
    const { host, store, state, run, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      host.save({ agentId: "sally", integration: "mcp:claap", scope: personal("A") }, connection("old-sally"));
      host.save({ agentId: "cira", integration: "mcp:claap", scope: personal("A") }, connection("old-cira"));
      host.save({ agentId: "sally", integration: "mcp:claap", scope: personal("B") }, connection("bob"));
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "connected" });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      await expect(store.disconnect("sally", "claap", personal("A"))).resolves.toBe(true);
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "disconnected" });
      expect(await state("cira", "claap", "A")).toMatchObject({ personalState: "disconnected" });
      await expect(run("cira", "claap", "A")).resolves.toMatchObject({ connected: false });
      await expect(run("sally", "claap", "A")).resolves.toMatchObject({ connected: false });
      expect(await state("sally", "claap", "B")).toMatchObject({ personalState: "connected" });
      await store.write("cira", "claap", connection("fresh"), personal("A"));
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "connected" });
      await expect(run("sally", "claap", "A")).resolves.toBe("fresh");
    } finally { await extension.stop(); }
  });
  it("refresh triggered via cira updates the shared record seen by sally", async () => {
    const { store, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", { ...connection("old"), tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" }, expiresAt: "2020-01-01T00:00:00Z" }, personal("A"));
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
        ? Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] })
        : Response.json({ access_token: "refreshed", token_type: "Bearer", expires_in: 3600 })));
      await expect(store.refreshAccessToken("cira", "claap", "A", personal("A"))).resolves.toBe("refreshed");
      await expect(store.read("sally", "claap", personal("A"))).resolves.toMatchObject({ tokens: { access_token: "refreshed" }, state: "connected" });
    } finally { await extension.stop(); }
  });
  it("markNeedsReconnect via cira is seen by sally", async () => {
    const { store, state, extension } = await setup({ sally: { claap: { url: URL_A } }, cira: { claap: { url: URL_A } } });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"));
      await store.markNeedsReconnect("cira", "claap", personal("A"));
      expect(await state("sally", "claap", "A")).toMatchObject({ personalState: "needs_reconnect" });
    } finally { await extension.stop(); }
  });
  it("adding a server already connected personally elsewhere skips OAuth", async () => {
    const { store, state, run, routes, extension } = await setup({ sally: { claap: { url: URL_A } }, connie: {} });
    try {
      await store.write("sally", "claap", connection("A"), personal("A"), { url: URL_A });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
      const add = (userId: string) => routes.get("POST /mcp/servers")!({
        ...context(userId, { agent: "connie" }),
        req: { query: (key: string) => ({ agent: "connie" } as Record<string, string>)[key], json: async () => ({ url: URL_A, credentialScope: "personal" }) },
      });
      const added = await add("A");
      expect(added.authorizationUrl).toBeUndefined();
      expect(added.server).toMatchObject({ personalState: "connected" });
      expect(await state("connie", added.server.name, "A")).toMatchObject({ personalState: "connected" });
      await expect(run("connie", added.server.name, "A")).resolves.toBe("A");
    } finally { await extension.stop(); }
  });
  it("adding a server whose shared personal grant needs reconnect still starts OAuth", async () => {
    const { store, routes, extension } = await setup({ sally: { claap: { url: URL_A } }, connie: {} });
    try {
      await store.write("sally", "claap", connection("A", "needs_reconnect"), personal("A"), { url: URL_A });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
      const added = await routes.get("POST /mcp/servers")!({
        ...context("A", { agent: "connie" }),
        req: { query: (key: string) => ({ agent: "connie" } as Record<string, string>)[key], json: async () => ({ url: URL_A, credentialScope: "personal" }) },
      });
      // OAuth begin is attempted (and fails here: no auth server is mocked), so no server card is returned.
      expect(added.server).toBeUndefined();
    } finally { await extension.stop(); }
  });
});
