import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClientManager, SdkMcpClientHandle } from "../client-manager.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function upstream(configure?: (server: McpServer) => void) {
  const server = new McpServer({ name: "apps-fixture", version: "1" });
    configure?.(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  cleanup.push(() => server.close());
  const client = await SdkMcpClientHandle.connect(
    { name: "fixture", type: "stdio", command: "unused" }, undefined, false,
    { transportFactory: () => clientTransport },
  );
  cleanup.push(() => client.close());
  return { server, client };
}

describe("MCP Apps SDK connection", () => {
  it("advertises the UI extension in the actual initialize request", async () => {
    const { server } = await upstream();
    expect(server.server.getClientCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });
  });
  it("preserves metadata and separates valid views from visibility", async () => {
    const { client } = await upstream((server) => {
      for (const [name, meta] of [
        ["view", { ui: { resourceUri: "ui://fixture/view", visibility: ["app"] }, extra: { keep: true } }],
        ["flat", { "ui/resourceUri": "ui://fixture/legacy" }],
        ["malformed", { ui: { resourceUri: "ui://fixture/view", visibility: ["app", "invalid"] } }],
        ["helper", { ui: { resourceUri: "https://invalid.test", visibility: ["app"] } }],
      ] as const) server.registerTool(name, { _meta: meta }, async () => ({ content: [] }));
    });
    const tools = await client.listTools();
    expect(tools.map(({ name, visibility, ui, _meta }) => ({ name, visibility, ui, _meta }))).toEqual([
      { name: "view", visibility: ["app"], ui: { resourceUri: "ui://fixture/view", visibility: ["app"] }, _meta: { ui: { resourceUri: "ui://fixture/view", visibility: ["app"] }, extra: { keep: true } } },
      { name: "flat", visibility: ["model", "app"], ui: { resourceUri: "ui://fixture/legacy", visibility: ["model", "app"] }, _meta: { "ui/resourceUri": "ui://fixture/legacy" } },
      { name: "malformed", visibility: ["model"], ui: { resourceUri: "ui://fixture/view", visibility: ["model"] }, _meta: { ui: { resourceUri: "ui://fixture/view", visibility: ["app", "invalid"] } } },
      { name: "helper", visibility: ["app"], ui: undefined, _meta: { ui: { resourceUri: "https://invalid.test", visibility: ["app"] } } },
    ]);
  });
  it("returns resource contents including CSP and tool results unchanged", async () => {
    const { client } = await upstream((server) => {
      server.registerResource("view", "ui://fixture/view", {}, async () => ({ contents: [
        { uri: "ui://fixture/view", mimeType: "text/html;profile=mcp-app", text: "<h1>Fixture</h1>", _meta: { ui: { csp: { connectDomains: ["https://example.test"] } } } },
      ] }));
      server.registerTool("result", {}, async () => ({ content: [{ type: "text", text: "old host text" }], structuredContent: { answer: 42 }, _meta: { onlyApp: true }, isError: true }));
    });
    await expect(client.readResource("ui://fixture/view")).resolves.toEqual({ contents: [
      { uri: "ui://fixture/view", mimeType: "text/html;profile=mcp-app", text: "<h1>Fixture</h1>", _meta: { ui: { csp: { connectDomains: ["https://example.test"] } } } },
    ] });
    await expect(client.callTool("result", {})).resolves.toEqual({ content: [{ type: "text", text: "old host text" }], structuredContent: { answer: 42 }, _meta: { onlyApp: true }, isError: true });
  });

  it("aborts a pending connection immediately and closes its late result", async () => {
    const controller = new AbortController();
    let finish!: (value: SdkMcpClientHandle) => void;
    const { client } = await upstream();
    const close = vi.spyOn(client, "close");
    const manager = new McpClientManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      signal: controller.signal, throwOnError: true,
      clientFactory: async (_server, _token, options) => {
        expect(options?.signal).toBe(controller.signal);
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    const connecting = manager.connect();
    const rejected = expect(connecting).rejects.toThrow("viewer left");
    controller.abort(new Error("viewer left"));
    await rejected;
    finish(client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalled();
    expect(manager.hasClient("fixture")).toBe(false);
  });

  it("does not turn an aborted catalog request into an empty catalog", async () => {
    const controller = new AbortController();
    const { client } = await upstream((server) => server.registerTool("data", {}, async () => ({ content: [] })));
    const original = client.listTools.bind(client);
    client.listTools = async (options) => {
      expect(options?.signal).toBe(controller.signal);
      return new Promise(() => {});
    };
    const manager = new McpClientManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      signal: controller.signal, throwOnError: true, clientFactory: async () => client,
    });
    await manager.connect();
    const pending = manager.listTools();
    const rejected = expect(pending).rejects.toThrow("catalog cancelled");
    controller.abort(new Error("catalog cancelled"));
    await rejected;
    client.listTools = original;
  });

  it("reads a resource through the named manager connection", async () => {
    const { client } = await upstream((server) => server.registerResource("view", "ui://fixture/view", {}, async () => ({ contents: [{ uri: "ui://fixture/view", text: "<p>Named server</p>" }] })));
    const manager = new McpClientManager([{ name: "fixture", type: "stdio", command: "unused" }], { throwOnError: true, clientFactory: async () => client });
    await manager.connect();
    await expect(manager.readResource("fixture", "ui://fixture/view")).resolves.toEqual({ contents: [{ uri: "ui://fixture/view", text: "<p>Named server</p>" }] });
  });

  it("does not reconnect after cancellation during authentication recovery", async () => {
    const controller = new AbortController();
    const { client } = await upstream();
    client.callTool = async () => { throw new Error("401 Unauthorized"); };
    let started!: () => void;
    let finish!: (value: boolean) => void;
    const recovering = new Promise<void>((resolve) => { started = resolve; });
    const factory = vi.fn(async () => client);
    const manager = new McpClientManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      signal: controller.signal, throwOnError: true, clientFactory: factory,
      onAuthFailure: async () => { started(); return new Promise((resolve) => { finish = resolve; }); },
    });
    await manager.connect();
    const pending = manager.invokeTool("fixture", "result", {});
    const rejected = expect(pending).rejects.toThrow("recovery cancelled");
    await recovering;
    controller.abort(new Error("recovery cancelled"));
    await rejected;
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reports reconnect when a refreshed connection still refuses its catalog", async () => {
    const { client } = await upstream();
    client.listTools = async () => { throw new Error("401 Unauthorized"); };
    const manager = new McpClientManager([{ name: "fixture", type: "stdio", command: "unused" }], {
      throwOnError: true, clientFactory: async () => client, onAuthFailure: async () => true,
    });
    await manager.connect();
    await expect(manager.listTools()).rejects.toMatchObject({ reason: "needs_reconnect" });
  });

});
