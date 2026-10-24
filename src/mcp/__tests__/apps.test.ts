import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpExtension } from "../index.js";
import { tempDirs } from "./harness.js";
import { appsFixture } from "./apps-fixture.js";

const dirs = tempDirs();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); await dirs.cleanup(); });
async function setup() {
  const dir = await dirs.make("mcp-apps-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { one: { command: "fixture" }, two: { command: "fixture" } } }));
  const hostDir = await dirs.make("mcp-apps-host-");
  await fs.writeFile(path.join(hostDir, "mcp.json"), JSON.stringify({ mcpServers: { disabled: { url: "https://disabled.example.test/mcp" } } }));
  const fixture = appsFixture();
  const extension = createMcpExtension(fixture.factory);
  const agent = { id: "casey", workspaceDir: dir };
  await extension.start({ getDataDir: () => hostDir, getConfig: () => ({}), getAgent: (id) => id === agent.id ? agent : undefined });
  cleanup.push(async () => { await extension.stop(); await fixture.close(); });
  return { extension, agent, fixture, dir };
}

describe("MCP Apps extension", () => {
  it("keeps an upstream JSON-RPC timeout error distinct from the host deadline", async () => {
    const { extension } = await setup();
    await expect(extension.mcpApps.readResource({ agentId: "casey" }, "one", "ui://test/rpc-error")).rejects.toMatchObject({ name: "McpAppsError", reason: "upstream", message: expect.stringContaining("upstream request deadline") });
  });

  it.each(["read", "call"])("rejects unknown agents and disabled/unknown servers for %s", async (operation) => {
    const { extension, fixture } = await setup();
    const invoke = (agentId: string, server: string) => operation === "call"
      ? extension.mcpApps.callTool({ agentId }, server, "a-b", {})
      : extension.mcpApps.readResource({ agentId }, server, "ui://test/view");
    await expect(invoke("missing", "one")).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_agent" });
    await expect(invoke("casey", "missing")).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_server" });
    await expect(invoke("casey", "disabled")).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_server" });
    expect(fixture.calls).toEqual([]);
  });
  it("rejects without a started runtime and preserves upstream resource errors", async () => {
    const unstarted = createMcpExtension();
    await expect(unstarted.mcpApps.readResource({ agentId: "casey" }, "one", "ui://test/view")).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_agent" });
    await expect(unstarted.mcpApps.callTool({ agentId: "casey" }, "one", "a-b", {})).rejects.toMatchObject({ name: "McpAppsError", reason: "unknown_agent" });
    const { extension } = await setup();
    await expect(extension.mcpApps.readResource({ agentId: "casey" }, "one", "ui://test/missing")).rejects.toMatchObject({ name: "McpAppsError", reason: "upstream", message: expect.stringContaining("not found") });
  });

  it("keeps legacy model results unchanged for a server ignoring the UI capability", async () => {
    const { extension, agent } = await setup();
    const tools = await extension.getAgentTools(agent, { config: {} });
    await expect(tools.find((tool) => tool.name === "mcp__one__legacy")!.execute({})).resolves.toEqual({ content: [{ type: "text", text: "one:legacy" }], structuredContent: { tool: "legacy" }, _meta: { private: "view-data" } });
  });

  it.each([["a_b", "one:a_b", false], ["helper", "one:helper", false], ["error", "one:error", true]] as const)("preserves raw %s app results including upstream error results", async (tool, text, isError) => {
    const { extension } = await setup();
    await expect(extension.mcpApps.callTool({ agentId: "casey" }, "one", tool, {})).resolves.toEqual({ content: [{ type: "text", text }], structuredContent: { tool }, _meta: { private: "view-data" }, ...(isError ? { isError: true } : {}) });
  });

  it.each([["model", "not_app_visible"], ["malformed", "not_app_visible"], ["missing", "unknown_tool"]])("refuses %s with %s before upstream dispatch", async (tool, reason) => {
    const { extension, fixture } = await setup();
    await expect(extension.mcpApps.callTool({ agentId: "casey" }, "one", tool!, {})).rejects.toMatchObject({ name: "McpAppsError", reason });
    expect(fixture.calls).toEqual([]);
  });

  it("calls app-only tools on the named server and preserves the raw result", async () => {
    const { extension, fixture } = await setup();
    await expect(extension.mcpApps.callTool({ agentId: "casey" }, "two", "a-b", {})).resolves.toEqual({ content: [{ type: "text", text: "two:a-b" }], structuredContent: { tool: "a-b" }, _meta: { private: "view-data" } });
    expect(fixture.calls).toEqual([{ server: "two", tool: "a-b" }]);
  });

  it("loads the raw UI resource without prior model discovery", async () => {
    const { extension } = await setup();
    await expect(extension.mcpApps.readResource({ agentId: "casey" }, "one", "ui://test/view")).resolves.toEqual({ contents: [{ uri: "ui://test/view", mimeType: "text/html;profile=mcp-app", text: "<html>view</html>", _meta: { ui: { csp: { connectDomains: ["https://api.example.test"] } } } }] });
  });

  it("hides app-only tools after naming the complete catalog and dispatches the visible collision correctly", async () => {
    const { extension, agent, fixture } = await setup();
    const tools = await extension.getAgentTools(agent, { config: {} });
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__one__a_b__2", "mcp__one__model", "mcp__one__flat", "mcp__one__malformed", "mcp__one__legacy", "mcp__one__error",
      "mcp__two__a_b__2", "mcp__two__model", "mcp__two__flat", "mcp__two__malformed", "mcp__two__legacy", "mcp__two__error",
    ]);
    expect(tools[0]).toMatchObject({ mcp: { server: "one", tool: "a_b", ui: { resourceUri: "ui://test/view", visibility: ["model", "app"] } } });
    expect(tools[1]).toMatchObject({ mcp: { server: "one", tool: "model" } });
    expect(tools[2]).toMatchObject({ mcp: { server: "one", tool: "flat", ui: { resourceUri: "ui://test/old", visibility: ["model", "app"] } } });
    await expect(tools[0]!.execute({})).resolves.toEqual({ content: [{ type: "text", text: "one:a_b" }], structuredContent: { tool: "a_b" }, _meta: { private: "view-data" } });
    expect(fixture.calls).toEqual([{ server: "one", tool: "a_b" }]);
  });
});
