import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpClientFactory } from "../client-manager.js";
import { SdkMcpClientHandle } from "../client-manager.js";

/** Real upstream protocol fixture; only its transport is substituted. */
export function appsFixture() {
  const servers: McpServer[] = [];
  const calls: Array<{ server: string; tool: string }> = [];
  const factory: McpClientFactory = async (config, token, options) => {
    const upstream = new McpServer({ name: config.name, version: "1" });
    servers.push(upstream);
    for (const [name, meta] of [
      ["a-b", { ui: { visibility: ["app"] } }],
      ["a_b", { ui: { resourceUri: "ui://test/view", visibility: ["model", "app"] } }],
      ["model", { ui: { visibility: ["model"] } }],
      ["flat", { "ui/resourceUri": "ui://test/old" }],
      ["malformed", { ui: { visibility: ["app", "surprise"] } }],
      ["helper", { ui: { resourceUri: "https://invalid.test", visibility: ["app"] } }],
      ["legacy", undefined],
      ["error", undefined],
    ] as const) {
      upstream.registerTool(name, { description: name, inputSchema: {}, ...(meta ? { _meta: meta } : {}) }, async () => {
        calls.push({ server: config.name, tool: name });
        return { content: [{ type: "text", text: `${config.name}:${name}` }], structuredContent: { tool: name }, _meta: { private: "view-data" }, ...(name === "error" ? { isError: true } : {}) };
      });
    }
    upstream.registerResource("view", "ui://test/view", { mimeType: "text/html;profile=mcp-app" }, async () => ({ contents: [{ uri: "ui://test/view", mimeType: "text/html;profile=mcp-app", text: "<html>view</html>", _meta: { ui: { csp: { connectDomains: ["https://api.example.test"] } } } }] }));
    upstream.registerResource("rpc-error", "ui://test/rpc-error", {}, async () => { throw new McpError(-32001, "upstream request deadline"); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    return SdkMcpClientHandle.connect(config, token, false, { ...options, transportFactory: () => clientTransport });
  };
  return { factory, calls, async close() { await Promise.all(servers.map((server) => server.close())); } };
}
