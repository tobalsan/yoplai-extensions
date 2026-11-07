import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await dirs.cleanup(); });

function connection(token: string): OAuthConnection {
  return { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" };
}

/**
 * Fake MCP upstream that behaves like the SDK transport: closing a client rejects its pending calls
 * with "Connection closed", and later calls fail with "Not connected".
 */
function upstream() {
  type Client = { server: string; token: string | undefined; closed: boolean; finished: boolean; closedEarly: boolean };
  const clients: Client[] = [];
  const gates: Array<{ client: Client; release: () => void }> = [];
  let blockNext = false;
  let onBlocked: (() => void) | undefined;
  const factory = async (server: { name: string }, token?: string) => {
    const client: Client = { server: server.name, token, closed: false, finished: false, closedEarly: false };
    clients.push(client);
    let failPending: ((error: Error) => void) | undefined;
    return {
      async listTools() { return [{ server: server.name, name: "lookup", description: "Lookup", inputSchema: { type: "object" }, visibility: ["model", "app"] as ("model" | "app")[] }]; },
      async readResource() { return { contents: [] }; },
      async callTool() {
        if (client.closed) throw new Error("Not connected");
        if (blockNext) {
          blockNext = false;
          await new Promise<void>((resolve, reject) => { failPending = reject; gates.push({ client, release: resolve }); onBlocked?.(); });
        }
        client.finished = true;
        return { content: [{ type: "text", text: `${server.name}:${token ?? "none"}` }] };
      },
      async close() {
        if (!client.finished) client.closedEarly = true;
        client.closed = true;
        failPending?.(new Error("MCP error -32000: Connection closed"));
      },
    };
  };
  return {
    clients,
    factory,
    /** Blocks the next tool call inside the upstream; resolves once it is blocked, returns its release. */
    blockNextCall() {
      blockNext = true;
      return new Promise<() => void>((resolve) => { onBlocked = () => resolve(gates.at(-1)!.release); });
    },
  };
}

async function setup() {
  const dir = await dirs.make("mcp-reset-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {
    remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } },
    plain: { url: "https://plain.example.test/mcp", headers: { "X-Fixture": "static" } },
  } }));
  // Upstream revocation during disconnect is an external adapter; it is unavailable here.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
  await store.write("casey", "remote", connection("team-token"));
  await store.write("casey", "remote", connection("bob-token"), { type: "personal", userId: "bob" });
  await store.write("casey", "remote", connection("alice-token"), { type: "personal", userId: "alice" });
  const fake = upstream();
  const extension = createMcpExtension(fake.factory);
  const agent = { id: "casey", workspaceDir: dir };
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
  const routes = routeApp(); extension.registerRoutes(routes);
  const disconnect = (userId: string) => routes.routes.get("POST /mcp/oauth/disconnect")!(routeContext({ agent: "casey", server: "remote", scope: "personal" }, { user: { id: userId } }));
  const tools = async (userId: string) => Object.fromEntries((await extension.getAgentTools(agent, { userId, config: {} })).map((tool) => [tool.name, tool]));
  return { extension, store, fake, disconnect, tools };
}

describe("MCP reset while calls are in flight", () => {
  it("lets another user's running OAuth tool call finish when someone disconnects", async () => {
    const { extension, fake, disconnect, tools } = await setup();
    try {
      const bob = await tools("bob");
      const blocked = fake.blockNextCall();
      const call = bob["mcp__remote__lookup"]!.execute({}, { userId: "bob" });
      const release = await blocked;
      await expect(disconnect("alice")).resolves.toEqual({ ok: true });
      release();
      await expect(call).resolves.toMatchObject({ content: [{ type: "text", text: "remote:bob-token" }] });
      const callClient = fake.clients.find((client) => client.finished && client.token === "bob-token")!;
      expect(callClient.closedEarly).toBe(false);
    } finally { await extension.stop(); }
  });

  it("uses the changed credentials for the next tool load and the next OAuth call", async () => {
    const { extension, fake, disconnect, tools } = await setup();
    try {
      const before = await tools("bob");
      expect(fake.clients.map((client) => [client.server, client.token])).toEqual(expect.arrayContaining([["remote", "bob-token"], ["plain", undefined]]));
      expect(fake.clients).toHaveLength(2);
      await expect(disconnect("bob")).resolves.toEqual({ ok: true });
      const after = await tools("bob");
      expect(fake.clients.slice(2).map((client) => [client.server, client.token])).toEqual(expect.arrayContaining([["remote", "team-token"], ["plain", undefined]]));
      expect(fake.clients).toHaveLength(4);
      await expect(after["mcp__remote__lookup"]!.execute({}, { userId: "bob" })).resolves.toMatchObject({ content: [{ type: "text", text: "remote:team-token" }] });
      await expect(before["mcp__remote__lookup"]!.execute({}, { userId: "bob" })).resolves.toMatchObject({ content: [{ type: "text", text: "remote:team-token" }] });
    } finally { await extension.stop(); }
  });

  it("keeps a running agent's static-header tool working right after another user's reconnect", async () => {
    const { extension, fake, disconnect, tools } = await setup();
    try {
      const bob = await tools("bob");
      const blocked = fake.blockNextCall();
      const running = bob["mcp__plain__lookup"]!.execute({}, { userId: "bob" });
      const release = await blocked;
      await expect(disconnect("alice")).resolves.toEqual({ ok: true });
      release();
      await expect(running).resolves.toMatchObject({ content: [{ type: "text", text: "plain:none" }] });
      await expect(bob["mcp__plain__lookup"]!.execute({}, { userId: "bob" })).resolves.toMatchObject({ content: [{ type: "text", text: "plain:none" }] });
    } finally { await extension.stop(); }
  });

  it("closes the replaced tool-list connections only after a grace period of minutes", async () => {
    const { extension, fake, disconnect, tools } = await setup();
    try {
      const bob = await tools("bob");
      const replaced = [...fake.clients];
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await expect(disconnect("alice")).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(replaced.map((client) => client.closed)).toEqual([false, false]);
      await expect(bob["mcp__plain__lookup"]!.execute({}, { userId: "bob" })).resolves.toMatchObject({ content: [{ type: "text", text: "plain:none" }] });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(replaced.map((client) => client.closed)).toEqual([true, true]);
    } finally { await extension.stop(); }
  });

  it("closes replaced and current connections at once on stop", async () => {
    const { extension, fake, disconnect, tools } = await setup();
    await tools("bob");
    await disconnect("alice");
    await tools("bob");
    expect(fake.clients).toHaveLength(4);
    expect(fake.clients.some((client) => client.closed)).toBe(false);
    await extension.stop();
    expect(fake.clients.map((client) => client.closed)).toEqual([true, true, true, true]);
  });
});
