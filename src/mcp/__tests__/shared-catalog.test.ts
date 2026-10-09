import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function ctx(role: string, body?: unknown, query: Record<string, string> = {}) {
  return {
    get: () => ({ user: { id: "u1", role } }),
    req: { query: (key: string) => query[key], json: async () => body },
    json: (value: unknown) => value,
    text: (value: string, status?: number) => ({ value, status }),
    html: (value: string) => value,
    redirect: (value: string) => value,
  };
}

async function setup(agentFiles: Record<string, unknown> = {}, catalog?: unknown) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-home-")); dirs.push(home);
  const agentDir = path.join(home, "agent"); await fs.mkdir(agentDir);
  if (catalog) await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify(catalog));
  if ("mcp.json" in agentFiles) await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(agentFiles["mcp.json"]));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
  const started: string[] = [];
  const extension = createMcpExtension(async (server: { name: string }) => {
    started.push(server.name);
    return {
      async listTools() { return [{ server: server.name, name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
      async callTool() { return "pong"; },
      async close() {},
      getServerInfo: () => ({ title: "Reported", description: "Reported description" }),
    } as never;
  });
  const record = vi.fn();
  const agent = { id: "a1", workspaceDir: agentDir };
  await extension.start({ audit: { record }, getDataDir: () => home, getConfig: () => ({ agents: [{ id: "a1" }], extensions: { multiUser: { enabled: true } } }), getAgent: () => agent } as never);
  const routes = new Map<string, (c: any) => Promise<any>>();
  extension.registerRoutes({ get: (p: string, h: any) => routes.set(`GET ${p}`, h), post: (p: string, h: any) => routes.set(`POST ${p}`, h) });
  const call = (route: string, c: unknown) => routes.get(route)!(c);
  const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
  return { extension, call, home, agent, agentDir, started, record, read };
}

describe("shared MCP catalog", () => {
  it("allows only superadmins to manage the catalog and validates adds", async () => {
    const t = await setup();
    expect(await t.call("GET /mcp/catalog", ctx("admin"))).toMatchObject({ status: 403 });
    expect(await t.call("POST /mcp/catalog", ctx("admin", { url: "https://mcp.linear.app/mcp" }))).toMatchObject({ status: 403 });
    expect(await t.call("POST /mcp/catalog", ctx("superadmin", { url: "ftp://x.test" }))).toMatchObject({ status: 400 });
    expect(await t.call("POST /mcp/catalog", ctx("superadmin", { url: "https://x.test/mcp", command: "node" }))).toMatchObject({ status: 400 });
    const added = await t.call("POST /mcp/catalog", ctx("superadmin", { url: "https://mcp.linear.app/mcp", displayName: "  Linear  ", description: "Issues" }));
    expect(added.server).toMatchObject({ name: "linear", displayName: "Linear", description: "Issues" });
    expect(await t.call("POST /mcp/catalog", ctx("superadmin", { url: "https://mcp.linear.app/mcp" }))).toMatchObject({ status: 409 });
    const second = await t.call("POST /mcp/catalog", ctx("superadmin", { url: "https://mcp.linear.app/other" }));
    expect(second.server.name).toBe("linear_2");
    expect(await t.call("POST /mcp/catalog/update", ctx("admin", { displayName: "x" }, { server: "linear" }))).toMatchObject({ status: 403 });
    await t.call("POST /mcp/catalog/update", ctx("superadmin", { displayName: "", description: "New" }, { server: "linear" }));
    const listed = await t.call("GET /mcp/catalog", ctx("superadmin"));
    expect(listed.servers.find((s: any) => s.name === "linear")).toEqual(expect.objectContaining({ description: "New" }));
    expect(listed.servers.find((s: any) => s.name === "linear").displayName).toBeUndefined();
    expect(await t.call("POST /mcp/catalog/remove", ctx("admin", undefined, { server: "linear" }))).toMatchObject({ status: 403 });
    expect(await t.call("POST /mcp/catalog/remove", ctx("superadmin", undefined, { server: "linear" }))).toEqual({ ok: true });
    expect(Object.keys((await t.read(path.join(t.home, "mcp.json"))).mcpServers)).toEqual(["linear_2"]);
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.remove", targetId: "linear" }));
    await t.extension.stop();
  });

  it("shows catalog cards to an agent without mcp.json, enables via sharedServers and merges tools only when enabled", async () => {
    const t = await setup({}, { mcpServers: { docs: { url: "https://docs.example.test/mcp", displayName: "Docs", description: "Shared docs" } } });
    const list = await t.call("GET /mcp/servers", ctx("user", undefined, { agent: "a1" }));
    expect(list.servers).toEqual([expect.objectContaining({ name: "docs", title: "Docs", description: "Shared docs", shared: true, enabled: false, readOnly: true, state: "disconnected" })]);
    expect(t.started).toEqual([]);
    const tools = { config: {}, userId: "u1" };
    expect(await t.extension.getAgentTools(t.agent, tools)).toEqual([]);
    const on = await t.call("POST /mcp/servers/shared", ctx("user", { enabled: true }, { agent: "a1", server: "docs" }));
    expect(on.server).toMatchObject({ shared: true, enabled: true, state: "connected" });
    expect((await t.read(path.join(t.agentDir, "mcp.json"))).sharedServers).toEqual(["docs"]);
    expect((await t.extension.getAgentTools(t.agent, tools)).map((tool: any) => tool.name)).toEqual(["mcp__docs__ping"]);
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.enable", targetId: "docs" }));
    await t.call("POST /mcp/servers/shared", ctx("user", { enabled: false }, { agent: "a1", server: "docs" }));
    expect((await t.read(path.join(t.agentDir, "mcp.json"))).sharedServers).toEqual([]);
    expect(await t.extension.getAgentTools(t.agent, tools)).toEqual([]);
    expect(await t.call("POST /mcp/servers/shared", ctx("user", { enabled: true }, { agent: "a1", server: "nope" }))).toMatchObject({ status: 404 });
    await t.extension.stop();
  });

  it("records the reported name of an enabled shared server as serverTitle, never over an admin label", async () => {
    const t = await setup({ "mcp.json": { mcpServers: {}, sharedServers: ["docs", "named"] } }, { mcpServers: {
      docs: { url: "https://docs.example.test/mcp" },
      named: { url: "https://named.example.test/mcp", displayName: "Admin name" },
    } });
    const list = await t.call("GET /mcp/servers", ctx("user", undefined, { agent: "a1" }));
    expect(list.servers.map((s: any) => s.title)).toEqual(["Reported", "Admin name"]);
    const catalog = (await t.read(path.join(t.home, "mcp.json"))).mcpServers;
    expect(catalog.docs).toEqual({ url: "https://docs.example.test/mcp", serverTitle: "Reported" });
    expect(catalog.named).toEqual({ url: "https://named.example.test/mcp", displayName: "Admin name" });
    await t.extension.stop();
  });

  it("lets a local server with the same key or URL hide the catalog entry and keeps other fields", async () => {
    const t = await setup({ "mcp.json": { keep: 1, mcpServers: { claap: { url: "https://api.claap.io/mcp" }, mine: { url: "https://dup.example.test/mcp/" } } } }, { mcpServers: {
      claap: { url: "https://other.example.test/mcp" }, dup: { url: "https://DUP.example.test/mcp" }, extra: { url: "https://extra.example.test/mcp" } } });
    const list = await t.call("GET /mcp/servers", ctx("user", undefined, { agent: "a1" }));
    expect(list.servers.map((s: any) => [s.name, s.shared ?? false])).toEqual([["claap", false], ["mine", false], ["extra", true]]);
    await t.call("POST /mcp/servers/shared", ctx("user", { enabled: true }, { agent: "a1", server: "extra" }));
    expect(await t.read(path.join(t.agentDir, "mcp.json"))).toMatchObject({ keep: 1, sharedServers: ["extra"] });
    await t.extension.stop();
  });

  it("sets and clears local labels; manual labels beat serverInfo and the known-host table", async () => {
    const t = await setup({ "mcp.json": { mcpServers: { cal: { url: "https://calendarmcp.googleapis.com/mcp/v1", yoplaiManaged: true }, tool: { command: "node" } } } });
    const file = path.join(t.agentDir, "mcp.json");
    expect(await t.call("POST /mcp/servers/label", ctx("user", { displayName: "x" }, { agent: "a1", server: "cal" }))).toMatchObject({ status: 403 });
    expect(await t.call("POST /mcp/servers/label", ctx("admin", { displayName: "x" }, { agent: "a1", server: "cal" }))).toMatchObject({ status: 403 });
    expect(await t.call("GET /mcp/servers", ctx("admin", undefined, { agent: "a1" }))).toMatchObject({ canEditLabels: false });
    expect(await t.call("GET /mcp/servers", ctx("superadmin", undefined, { agent: "a1" }))).toMatchObject({ canEditLabels: true });
    await t.call("POST /mcp/servers/label", ctx("superadmin", { displayName: `  ${"n".repeat(150)} `, description: "Mine" }, { agent: "a1", server: "cal" }));
    await t.call("POST /mcp/servers/label", ctx("superadmin", { displayName: "Stdio tool" }, { agent: "a1", server: "tool" }));
    expect((await t.read(file)).mcpServers.cal.displayName).toHaveLength(100);
    const cards = (await t.call("GET /mcp/servers", ctx("user", undefined, { agent: "a1" }))).servers;
    expect(cards.find((s: any) => s.name === "cal")).toMatchObject({ title: "n".repeat(100), description: "Mine", manualLabel: { description: "Mine" } });
    expect(cards.find((s: any) => s.name === "tool").title).toBe("Stdio tool");
    expect((await t.read(file)).mcpServers.cal.description).toBe("Mine");
    await t.call("POST /mcp/servers/label", ctx("superadmin", { displayName: "", description: " " }, { agent: "a1", server: "cal" }));
    const cleared = (await t.read(file)).mcpServers.cal;
    expect(cleared.displayName ?? cleared.description).toBeUndefined();
    expect(await t.call("POST /mcp/servers/label", ctx("superadmin", { displayName: "x" }, { agent: "a1", server: "missing" }))).toMatchObject({ status: 404 });
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.server.update", targetId: "cal" }));
    await t.extension.stop();
  });

  it("strips a removed catalog key from agents so a reused key needs fresh opt-in", async () => {
    const t = await setup({ "mcp.json": { mcpServers: {}, sharedServers: ["docs"] } }, { mcpServers: { docs: { url: "https://docs.example.test/mcp" } } });
    expect(await t.call("POST /mcp/catalog/remove", ctx("superadmin", undefined, { server: "docs" }))).toEqual({ ok: true });
    expect((await t.read(path.join(t.agentDir, "mcp.json"))).sharedServers).toEqual([]);
    const readded = await t.call("POST /mcp/catalog", ctx("superadmin", { url: "https://docs.test/mcp" }));
    expect(readded.server.name).toBe("docs");
    const list = await t.call("GET /mcp/servers", ctx("user", undefined, { agent: "a1" }));
    expect(list.servers.every((item: any) => item.enabled === false)).toBe(true);
    await t.extension.stop();
  });

  it("allocates a local key that avoids catalog keys", async () => {
    const t = await setup({}, { mcpServers: { docs: { url: "https://other.example.test/mcp" } } });
    await t.call("POST /mcp/servers", ctx("superadmin", { url: "https://docs.test/mcp", credentialScope: "team" }, { agent: "a1" }));
    expect(Object.keys((await t.read(path.join(t.agentDir, "mcp.json"))).mcpServers)).toEqual(["docs_2"]);
    await t.extension.stop();
  });
});
