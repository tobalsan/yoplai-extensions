import { afterEach, describe, expect, it, vi } from "vitest";

import { McpClientManager, type McpClientHandle } from "../client-manager.js";

afterEach(() => {
  vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
  vi.doUnmock("@modelcontextprotocol/sdk/client/stdio.js");
  vi.resetModules();
});

describe("McpClientManager", () => {
  it("lists and invokes healthy servers while recording failed servers", async () => {
    const calls: string[] = [];
    const manager = new McpClientManager(
      [
        { type: "stdio", name: "good", command: "node" },
        { type: "http", name: "bad", url: "https://example.com/mcp" },
      ],
      async (server): Promise<McpClientHandle> => {
        if (server.name === "bad") throw new Error("connection refused");
        return {
          async listTools() {
            return [
              {
                server: server.name,
                name: "echo",
                description: "Echo input",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ];
          },
          async callTool(name, args) {
            calls.push(`${server.name}:${name}`);
            return { args };
          },
          async close() {},
        };
      }
    );

    await manager.connect();
    const tools = await manager.listTools();

    expect(tools.map((tool) => `${tool.server}:${tool.name}`)).toEqual(["good:echo"]);
    await expect(manager.invoke("good__echo", { text: "hi" })).resolves.toEqual({
      args: { text: "hi" },
    });
    expect(calls).toEqual(["good:echo"]);
    expect(manager.getErrors()).toEqual([{ server: "bad", message: "connection refused" }]);
  });

  it("does not leak unrelated parent env vars to stdio servers with configured env", async () => {
    let stdioParams: { env?: Record<string, string> } | undefined;

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: class {
        async connect() {}
        async listTools() {
          return { tools: [] };
        }
        async callTool() {
          return {};
        }
      },
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      getDefaultEnvironment: () => ({ PATH: "/usr/bin", HOME: "/home/agent" }),
      StdioClientTransport: class {
        constructor(params: { env?: Record<string, string> }) {
          stdioParams = params;
        }
        async close() {}
      },
    }));

    const { SdkMcpClientHandle } = await import("../client-manager.js");

    await SdkMcpClientHandle.connect({
      type: "stdio",
      name: "filesystem",
      command: "mcp-server-filesystem",
      env: { MCP_TOKEN: "secret" },
    });

    expect(stdioParams?.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      MCP_TOKEN: "secret",
    });
    expect(stdioParams?.env).not.toHaveProperty("LINEAR_OAUTH_TOKEN");
  });
});
