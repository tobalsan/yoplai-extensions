import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { type McpClientFactory } from "../client-manager.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await dirs.cleanup(); });

// Approved in ALG-570 Testing Decisions: routes + persisted files cover capture/restarts,
// auth and editor behavior; fake remote clients do not cover SDK transport or browser rendering.
async function setup(entry: Record<string, unknown>, icon: () => string | undefined = () => "https://icons.test/server.png") {
  const home = await dirs.make("mcp-icons-");
  const agentDir = path.join(home, "agent");
  await fs.mkdir(agentDir);
  const file = path.join(agentDir, "mcp.json");
  const host = credentials();
  await fs.writeFile(file, JSON.stringify({ mcpServers: { remote: entry } }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  const factory: McpClientFactory = async () => ({
    async listTools() { return []; },
    async readResource() { return { contents: [] }; },
    async callTool() {}, async close() {}, getServerIcon: icon,
  });
  const start = async (clientFactory = factory, multiUser = false) => {
    const extension = createMcpExtension(clientFactory);
    await extension.start({ credentials: host, getDataDir: () => home, getConfig: () => ({ extensions: { multiUser: { enabled: multiUser } } }), getAgent: (id: string) => id === "agent" ? { id, workspaceDir: agentDir } : undefined });
    const app = routeApp(); extension.registerRoutes(app);
    return { extension, call: (route: string, query: Record<string, string> = {}, body?: unknown, role = "superadmin") => app.routes.get(route)!({ ...routeContext(query, { user: { id: "user-a", role } }), req: { query: (key: string) => query[key], json: async () => body } }) };
  };
  return { home, file, agentDir, host, start, read: async () => JSON.parse(await fs.readFile(file, "utf8")) };
}

it("saves a managed server icon and serves it after restart without network", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true });
  const first = await t.start();
  await expect(first.call("GET /mcp/servers", { agent: "agent", server: "remote" })).resolves.toMatchObject({ servers: [{ iconUrl: "https://icons.test/server.png" }] });
  expect((await t.read()).mcpServers.remote.serverIcon).toBe("https://icons.test/server.png");
  await first.extension.stop();
  const network = vi.fn(() => { throw new Error("unexpected network"); });
  vi.stubGlobal("fetch", network);
  const fresh = await t.start(network);
  await expect(fresh.call("GET /mcp/servers", { agent: "agent", live: "0" })).resolves.toMatchObject({ servers: [{ iconUrl: "https://icons.test/server.png" }] });
  expect(network).not.toHaveBeenCalled();
  await fresh.extension.stop();
});

it("captures an enabled shared server icon for catalog and agent cards", async () => {
  const t = await setup({ url: "https://local.example.test/mcp" });
  await fs.writeFile(t.file, JSON.stringify({ mcpServers: {}, sharedServers: ["shared"] }));
  await fs.writeFile(path.join(t.home, "mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "https://shared.example.test/mcp" } } }));
  const live = await t.start();
  await expect(live.call("GET /mcp/servers", { agent: "agent", server: "shared" })).resolves.toMatchObject({ servers: [{ shared: true, iconUrl: "https://icons.test/server.png" }] });
  expect(JSON.parse(await fs.readFile(path.join(t.home, "mcp.json"), "utf8")).mcpServers.shared.serverIcon).toBe("https://icons.test/server.png");
  await expect(live.call("GET /mcp/catalog")).resolves.toMatchObject({ servers: [{ iconUrl: "https://icons.test/server.png" }] });
  await expect(live.call("GET /mcp/servers", { agent: "agent", live: "0" })).resolves.toMatchObject({ servers: [{ iconUrl: "https://icons.test/server.png" }] });
  await live.extension.stop();
});

it("refreshes a user icon, persists it, and keeps it when initialize later omits icons", async () => {
  let reported: string | undefined = "https://icons.test/new.png";
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true, serverIcon: "https://icons.test/old.png" }, () => reported);
  const live = await t.start();
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "updated", server: { iconUrl: "https://icons.test/new.png" } });
  expect((await t.read()).mcpServers.remote.serverIcon).toBe("https://icons.test/new.png");
  reported = undefined;
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "unchanged", server: { iconUrl: "https://icons.test/new.png" } });
  await live.extension.stop();
});

it("never reports updated when saving a managed icon fails, and keeps the old icon on disk", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true, serverIcon: "https://icons.test/old.png" }, () => "https://icons.test/new.png");
  const before = await fs.readFile(t.file, "utf8");
  const live = await t.start();
  const rename = syncFs.renameSync;
  const spy = vi.spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
    if (to === t.file) throw new Error("disk full");
    return rename(from, to);
  });
  const result = await live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" }) as { status: string; error?: string; server: { iconUrl?: string } };
  spy.mockRestore();
  expect(result.status).toBe("save_failed");
  expect(result.error).toContain("disk full");
  expect(result.server.iconUrl).toBe("https://icons.test/old.png");
  expect(await fs.readFile(t.file, "utf8")).toBe(before);
  await expect(live.call("GET /mcp/servers", { agent: "agent", live: "0" })).resolves.toMatchObject({ servers: [{ iconUrl: "https://icons.test/old.png" }] });
  await live.extension.stop();
});

it("hides the saved icon in the editor and ignores submitted replacements", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true, serverIcon: "https://icons.test/saved.png" });
  const live = await t.start();
  const query = { agent: "agent", server: "remote" };
  const result = await live.call("GET /mcp/servers/config", query);
  expect(result.config).not.toHaveProperty("serverIcon");
  const saved = await live.call("POST /mcp/servers/config", query, { config: { url: "https://remote.example.test/changed", serverIcon: "https://icons.test/injected.png" } });
  expect(saved.config).not.toHaveProperty("serverIcon");
  expect((await t.read()).mcpServers.remote).toMatchObject({ url: "https://remote.example.test/changed", serverIcon: "https://icons.test/saved.png" });
  await live.extension.stop();
});

it("refreshes the unauthenticated catalog icon and returns it to the admin", async () => {
  const t = await setup({ url: "https://local.example.test/mcp" });
  const catalogFile = path.join(t.home, "mcp.json");
  await fs.writeFile(catalogFile, JSON.stringify({ mcpServers: { shared: { url: "https://shared.example.test/mcp" } } }));
  const live = await t.start();
  await expect(live.call("POST /mcp/catalog/icon/refresh", { server: "shared" })).resolves.toMatchObject({ status: "updated", server: { name: "shared", iconUrl: "https://icons.test/server.png" } });
  expect(JSON.parse(await fs.readFile(catalogFile, "utf8")).mcpServers.shared.serverIcon).toBe("https://icons.test/server.png");
  await live.extension.stop();
});

it("leaves an unconnected OAuth user server untouched and requires sign-in", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", oauth: { clientId: "client" }, yoplaiManaged: true, serverIcon: "https://icons.test/kept.png" });
  const original = await fs.readFile(t.file, "utf8");
  const network = vi.fn(() => { throw new Error("must connect first"); });
  vi.stubGlobal("fetch", network);
  const live = await t.start(network);
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "not_connected", server: { iconUrl: "https://icons.test/kept.png" } });
  expect(await fs.readFile(t.file, "utf8")).toBe(original);
  expect(network).not.toHaveBeenCalled();
  await live.extension.stop();
});

it("allows connected personal OAuth refresh and leaves hand-edited entries byte-for-byte intact", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", oauth: { clientId: "client" } });
  const store = new McpOAuthStore(t.home, "http://localhost/callback", t.host);
  await store.write("agent", "remote", { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "dummy", token_type: "Bearer" }, connectedAt: "2026-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test" }, { type: "personal", userId: "user-a" });
  const original = await fs.readFile(t.file, "utf8");
  const live = await t.start();
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "not_saved", server: { iconUrl: "https://icons.test/server.png" } });
  expect(await fs.readFile(t.file, "utf8")).toBe(original);
  await live.extension.stop();
});

it("returns not_connected for a catalog requiring sign-in and still replaces its website icon", async () => {
  const t = await setup({ url: "https://local.example.test/mcp" });
  const file = path.join(t.home, "mcp.json");
  await fs.writeFile(file, JSON.stringify({ mcpServers: { shared: { url: "https://shared.example.test/mcp" } } }));
  await fs.mkdir(path.join(t.home, "mcp"));
  await fs.writeFile(path.join(t.home, "mcp/icons.json"), JSON.stringify({ "shared.example.test": "https://icons.test/old.png" }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response('<link rel="icon" href="https://icons.test/new.png">', { headers: { "content-type": "text/html" } })));
  const live = await t.start(async () => { throw Object.assign(new Error("Unauthorized"), { code: 401 }); }, true);
  await expect(live.call("POST /mcp/catalog/icon/refresh", { server: "shared" }, undefined, "admin")).resolves.toMatchObject({ status: 403 });
  await expect(live.call("POST /mcp/catalog/icon/refresh", { server: "shared" })).resolves.toMatchObject({ status: "not_connected", server: { iconUrl: "https://icons.test/new.png" } });
  expect(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.shared).not.toHaveProperty("serverIcon");
  await live.extension.stop();
});

it("does nothing when an expired OAuth grant has no refresh token", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true, oauth: { clientId: "client" } });
  const store = new McpOAuthStore(t.home, "http://localhost/callback", t.host);
  await store.write("agent", "remote", { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "expired", token_type: "Bearer" }, connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test" }, { type: "personal", userId: "user-a" });
  const original = await fs.readFile(t.file, "utf8");
  const network = vi.fn(() => { throw new Error("unusable grant must not refresh icons"); });
  vi.stubGlobal("fetch", network);
  const live = await t.start(network);
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "not_connected" });
  expect(await fs.readFile(t.file, "utf8")).toBe(original);
  expect(network).not.toHaveBeenCalled();
  await live.extension.stop();
});

it("times out a catalog initialize, closes a late client, and keeps serving other requests", async () => {
  const t = await setup({ url: "https://local.example.test/mcp" });
  const catalogFile = path.join(t.home, "mcp.json");
  await fs.writeFile(catalogFile, JSON.stringify({ mcpServers: { slow: { url: "https://slow.example.test/mcp" } } }));
  let signal: AbortSignal | undefined;
  let finish!: (client: Awaited<ReturnType<McpClientFactory>>) => void;
  const factory: McpClientFactory = async (_server, _token, options) => {
    signal = options?.signal;
    return new Promise((resolve) => { finish = resolve; });
  };
  const live = await t.start(factory);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = live.call("POST /mcp/catalog/icon/refresh", { server: "slow" });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(pending).resolves.toMatchObject({ status: "unreachable", error: "MCP server status timed out" });
  expect(signal?.aborted).toBe(true);
  let closed = false;
  finish({ async listTools() { return []; }, async callTool() {}, async readResource() { return { contents: [] }; }, async close() { closed = true; }, getServerIcon: () => "https://icons.test/too-late.png" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toBe(true);
  expect(JSON.parse(await fs.readFile(catalogFile, "utf8")).mcpServers.slow).not.toHaveProperty("serverIcon");
  await expect(live.call("GET /mcp/servers", { agent: "agent", live: "0", server: "remote" })).resolves.toMatchObject({ servers: [{ name: "remote" }] });
  await live.extension.stop();
});

it("retries a memoized favicon miss, replaces a cached hit, and keeps a hit on a later miss", async () => {
  const t = await setup({ url: "https://remote.example.test/mcp", yoplaiManaged: true }, () => undefined);
  let found: string | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, options?: RequestInit) =>
    found && !String(input).includes(".well-known") && options?.method !== "POST"
      ? new Response(`<link rel="icon" href="${found}">`, { headers: { "content-type": "text/html" } })
      : new Response(null, { status: 404 })));
  const live = await t.start();
  await expect(live.call("GET /mcp/servers", { agent: "agent" })).resolves.toMatchObject({ servers: [{ iconUrl: undefined }] });
  found = "https://icons.test/retried.png";
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "updated", server: { iconUrl: "https://icons.test/retried.png" } });
  found = "https://icons.test/changed.png";
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "updated", server: { iconUrl: "https://icons.test/changed.png" } });
  found = undefined;
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: "unchanged", server: { iconUrl: "https://icons.test/changed.png" } });
  await live.extension.stop();
});

it("uses the known icon before a reported icon and cached favicon on every card surface", async () => {
  const t = await setup({ url: "https://calendarmcp.googleapis.com/mcp/v1", yoplaiManaged: true, serverIcon: "https://icons.test/saved.png" });
  await fs.writeFile(path.join(t.home, "mcp.json"), JSON.stringify({ mcpServers: { calendar: { url: "https://calendarmcp.googleapis.com/mcp/v1", serverIcon: "https://icons.test/catalog.png" } } }));
  const live = await t.start();
  const expected = "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png";
  await expect(live.call("GET /mcp/servers", { agent: "agent", server: "remote" })).resolves.toMatchObject({ servers: [{ iconUrl: expected }] });
  await expect(live.call("GET /mcp/servers", { agent: "agent", live: "0" })).resolves.toMatchObject({ servers: [{ iconUrl: expected }] });
  await expect(live.call("GET /mcp/catalog")).resolves.toMatchObject({ servers: [{ iconUrl: expected }] });
  await live.extension.stop();
});

it("rejects unknown, shared, and stdio refresh targets without rewriting config", async () => {
  const t = await setup({ command: "node" });
  await fs.writeFile(path.join(t.home, "mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "https://shared.example.test/mcp" } } }));
  const original = await fs.readFile(t.file, "utf8");
  const live = await t.start();
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "missing", server: "remote" })).resolves.toMatchObject({ status: 404 });
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "missing" })).resolves.toMatchObject({ status: 404 });
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "shared" })).resolves.toMatchObject({ status: 404 });
  await expect(live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" })).resolves.toMatchObject({ status: 400 });
  expect(await fs.readFile(t.file, "utf8")).toBe(original);
  await live.extension.stop();
});

it("bounds user refresh connection to ten seconds without a separate OAuth probe", async () => {
  const t = await setup({ url: "https://slow.example.test/mcp", yoplaiManaged: true });
  const network = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", network);
  let started = false;
  const live = await t.start(async () => { started = true; return new Promise<never>(() => {}); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let complete = false;
  const pending = live.call("POST /mcp/servers/icon/refresh", { agent: "agent", server: "remote" }).then((result) => { complete = true; return result; });
  while (!started && !network.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
  // The connection and favicon each have a bounded deadline, without a second initialize probe.
  // Step fake time and let real file I/O between timers settle, so the bound holds under suite load.
  for (let elapsed = 0; elapsed < 15_001 && !complete; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(complete).toBe(true);
  await expect(pending).resolves.toMatchObject({ status: "unreachable", server: { state: "unreachable", error: "MCP server status timed out" } });
  await live.extension.stop();
});

it("preserves existing live absolute HTTP icons for stdio servers without persisting metadata", async () => {
  const t = await setup({ command: "node", yoplaiManaged: true });
  const live = await t.start();
  await expect(live.call("GET /mcp/servers", { agent: "agent", server: "remote" })).resolves.toMatchObject({ servers: [{ type: "stdio", iconUrl: "https://icons.test/server.png" }] });
  expect((await t.read()).mcpServers.remote).not.toHaveProperty("serverIcon");
  await live.extension.stop();
});
