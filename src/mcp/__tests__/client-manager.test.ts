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
      { clientFactory: async (server): Promise<McpClientHandle> => {
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
      } }
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

  it("closes a client when tool discovery fails", async () => {
    const close = vi.fn(async () => undefined);
    const manager = new McpClientManager(
      [{ type: "stdio", name: "broken", command: "node" }],
      { clientFactory: async (): Promise<McpClientHandle> => ({
        async listTools() {
          throw new Error("discovery failed");
        },
        async callTool() {
          return undefined;
        },
        close,
      }) }
    );

    await manager.connect();
    await expect(manager.listTools()).resolves.toEqual([]);
    expect(close).toHaveBeenCalledOnce();

    await manager.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps discovery failure isolated when closing the failed client also fails", async () => {
    const manager = new McpClientManager(
      [{ type: "stdio", name: "broken", command: "node" }],
      { clientFactory: async (): Promise<McpClientHandle> => ({
        async listTools() {
          throw new Error("discovery failed");
        },
        async callTool() {
          return undefined;
        },
        async close() {
          throw new Error("close failed");
        },
      }) }
    );

    await manager.connect();
    await expect(manager.listTools()).resolves.toEqual([]);
    expect(manager.getErrors()).toEqual([
      { server: "broken", message: "discovery failed" },
      { server: "broken", message: "close failed" },
    ]);
    await expect(manager.close()).resolves.toBeUndefined();
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

  it("uses a refreshed OAuth token and marks 401 failures for reconnect", async () => {
    const marked: string[] = [];
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (_server, token) => {
          expect(token).toBe("fresh-token");
          throw new Error("401 Unauthorized");
        },
        tokenProvider: async () => "fresh-token",
        onAuthFailure: async (server) => { marked.push(server.name); return false; },
      }
    );

    await manager.connect();

    expect(marked).toEqual(["claap"]);
    expect(manager.getErrors()).toEqual([{ server: "claap", message: "401 Unauthorized" }]);
  });

  it("returns the structured not-connected response after a tool 401", async () => {
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async () => ({ async listTools() { return [{ server: "claap", name: "search", description: "", inputSchema: {} }]; }, async callTool() { throw new Error("401 Unauthorized"); }, async close() {} }),
        onAuthFailure: async () => false,
        notConnectedResponse: (server) => ({ connected: false, server, reason: "needs_reconnect" }),
      }
    );
    await manager.connect();
    await manager.listTools();
    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ connected: false, server: "claap", reason: "needs_reconnect" });
  });

  it("refreshes and reconnects an expired OAuth transport after a tool 401", async () => {
    const tokens = ["expired-token", "fresh-token"];
    const factory = vi.fn(async (_server, token): Promise<McpClientHandle> => ({
      async listTools() {
        return [{ server: "claap", name: "search", description: "", inputSchema: {} }];
      },
      async callTool() {
        if (token === "expired-token") throw new Error("401 Unauthorized");
        return { token };
      },
      async close() {},
    }));
    const refresh = vi.fn(async () => {
      tokens.shift();
      return true;
    });
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      { clientFactory: factory, tokenProvider: async () => tokens[0], onAuthFailure: refresh }
    );

    await manager.connect();
    await manager.listTools();

    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ token: "fresh-token" });
    expect(refresh).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenNthCalledWith(1, expect.anything(), "expired-token");
    expect(factory).toHaveBeenNthCalledWith(2, expect.anything(), "fresh-token");
  });

  it("shares reconnect work across concurrent 401s", async () => {
    let token = "expired-token";
    const factory = vi.fn(async (_server, currentToken): Promise<McpClientHandle> => ({
      async listTools() { return [{ server: "claap", name: "search", description: "", inputSchema: {} }]; },
      async callTool() {
        if (currentToken === "expired-token") throw new Error("401 Unauthorized");
        return { token: currentToken };
      },
      async close() {},
    }));
    const refresh = vi.fn(async () => { token = "fresh-token"; return true; });
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      { clientFactory: factory, tokenProvider: async () => token, onAuthFailure: refresh }
    );
    await manager.connect();
    await manager.listTools();

    await expect(Promise.all([manager.invoke("claap__search", {}), manager.invoke("claap__search", {})])).resolves.toEqual([
      { token: "fresh-token" }, { token: "fresh-token" },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("marks a still-unauthorized refreshed transport as needing reconnect", async () => {
    const terminal = vi.fn(async () => undefined);
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => ({
          async listTools() { return [{ server: "claap", name: "search", description: "", inputSchema: {} }]; },
          async callTool() { throw new Error("401 Unauthorized"); },
          async close() {},
        }),
        onAuthFailure: async () => true,
        notConnectedResponse: (server) => ({ connected: false, server, reason: "needs_reconnect" }),
        onUnrecoverableAuthFailure: terminal,
      }
    );

    await manager.connect();
    await manager.listTools();

    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ connected: false, server: "claap", reason: "needs_reconnect" });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ name: "claap" }));
  });

  it("marks a still-unauthorized refreshed transport during discovery as needing reconnect", async () => {
    const terminal = vi.fn(async () => undefined);
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => ({
          async listTools() { throw new Error("401 Unauthorized"); },
          async callTool() { return undefined; },
          async close() {},
        }),
        onAuthFailure: async () => true,
        onUnrecoverableAuthFailure: terminal,
      }
    );

    await manager.connect();

    await expect(manager.listTools()).resolves.toEqual([]);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ name: "claap" }));
  });

  it("marks a refreshed transport that 401s while reconnecting as needing reconnect", async () => {
    const terminal = vi.fn(async () => undefined);
    let connections = 0;
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => {
          connections += 1;
          if (connections === 2) throw new Error("401 Unauthorized");
          return {
            async listTools() { return [{ server: "claap", name: "search", description: "", inputSchema: {} }]; },
            async callTool() { throw new Error("401 Unauthorized"); },
            async close() {},
          };
        },
        onAuthFailure: async () => true,
        notConnectedResponse: (server) => ({ connected: false, server, reason: "needs_reconnect" }),
        onUnrecoverableAuthFailure: terminal,
      }
    );

    await manager.connect();
    await manager.listTools();

    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ connected: false, server: "claap", reason: "needs_reconnect" });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ name: "claap" }));
  });
});
