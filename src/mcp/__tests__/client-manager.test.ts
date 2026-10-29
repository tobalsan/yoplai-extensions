import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { McpClientManager, type McpClientHandle } from "../client-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
  vi.doUnmock("@modelcontextprotocol/sdk/client/stdio.js");
  vi.resetModules();
});

describe("McpClientManager", () => {
  it("provides full icon metadata while supporting handles with only getServerIcon", async () => {
    const manager = new McpClientManager([
      { name: "modern", type: "http", url: "https://modern.test/mcp" },
      { name: "legacy", type: "http", url: "https://legacy.test/mcp" },
    ], { clientFactory: async (server) => ({
      async listTools() { return []; }, async readResource() { return { contents: [] }; },
      async callTool() { return {}; }, async close() {},
      getServerIcon: () => "/first.png",
      ...(server.name === "modern" ? { getServerIcons: () => [{ src: "/light.png", theme: "light" as const, mimeType: "image/png" }] } : {}),
    }) });
    await manager.connect();
    try {
      expect(manager.getServerIcons("modern")).toEqual([{ src: "/light.png", theme: "light", mimeType: "image/png" }]);
      expect(manager.getServerIcons("legacy")).toEqual([{ src: "/first.png" }]);
      expect(manager.getServerIcon("legacy")).toBe("/first.png");
    } finally { await manager.close(); }
  });

  it("exposes the full icons list from the actual SDK initialize response", async () => {
    const upstream = new McpServer({ name: "icons", version: "1", icons: [
      { src: "/dark.png", mimeType: "image/png", sizes: ["48x48"], theme: "dark" },
      { src: "/light.svg", mimeType: "image/svg+xml", theme: "light" },
    ] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    const { SdkMcpClientHandle } = await import("../client-manager.js");
    const client = await SdkMcpClientHandle.connect({ name: "icons", type: "http", url: "https://example.test/mcp" }, undefined, true,
      { transportFactory: () => clientTransport });
    try {
      expect(client.getServerIcons()).toEqual([
        { src: "/dark.png", mimeType: "image/png", sizes: ["48x48"], theme: "dark" },
        { src: "/light.svg", mimeType: "image/svg+xml", theme: "light" },
      ]);
      expect(client.getServerIcon()).toBe("/dark.png");
    } finally { await client.close(); await upstream.close(); }
  });

  it.each([
    "Authorization: Bearer private-access\nCookie: session=private-cookie\naccess_token=private-token",
    'HTTP 401 {"headers":{"Authorization":"Bearer private-access","Cookie":"session=private-cookie"}}',
    "HTTP error with Bearer private-access",
  ])("removes credential details from logged errors and caps the reason at 300 characters: %s", async (message) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new McpClientManager([{ type: "stdio", name: "local", command: "node" }], {
      clientFactory: async () => { throw new Error(`${message}\n${"x".repeat(500)}`); },
    });
    await manager.connect();
    const line = output.mock.calls[0]![0];
    expect(line).not.toMatch(/private-access|private-cookie|private-token|[\r\n]/);
    const { msg } = JSON.parse(line);
    expect(msg).toContain('[mcp] server "local" unavailable: ');
    expect(msg.length).toBeLessThanOrEqual(334);
  });

  it("logs every transport failure as sanitized single-line JSON without changing errors or retries", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = "Connection closed https://example.test/mcp?token=abc\ntry again";
    const factory = vi.fn(async () => { throw new Error(message); });
    const manager = new McpClientManager([{ type: "http", name: "remote", url: "https://example.test/mcp" }], {
      clientFactory: factory,
      logContext: { agentId: "casey", userId: "alice", path: "status" },
    });
    await manager.connect();
    await manager.connect();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(manager.getErrors()).toEqual([{ server: "remote", message }, { server: "remote", message }]);
    expect(output.mock.calls).toHaveLength(2);
    for (const [line] of output.mock.calls) {
      expect(line.startsWith('{"level"')).toBe(true);
      expect(line).not.toMatch(/[\r\n]|token=abc/);
      expect(JSON.parse(line)).toEqual({
        level: "warn", msg: '[mcp] server "remote" unavailable: Connection closed https://example.test/mcp try again',
        server: "remote", agentId: "casey", userId: "alice", path: "status", reason: "transport_failed",
      });
    }
  });

  it("forwards RequestOptions to the SDK and rejects with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("401 cancelled by gateway");
    const sdkCall = vi.fn((_request: unknown, _schema: unknown, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
      async connect() {}
      callTool = sdkCall;
    } }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      getDefaultEnvironment: () => ({}), StdioClientTransport: class { async close() {} },
    }));
    vi.resetModules();
    const { SdkMcpClientHandle } = await import("../client-manager.js");
    const recover = vi.fn(async () => true);
    const manager = new McpClientManager([{ type: "stdio", name: "local", command: "node" }], {
      clientFactory: (server, token, options) => SdkMcpClientHandle.connect(server, token, false, options), onAuthFailure: recover,
    });
    await manager.connect();
    const pending = manager.invokeTool("local", "sleep", {}, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    expect(sdkCall).toHaveBeenCalledOnce();
    controller.abort(reason);
    await rejected;
    expect(sdkCall.mock.calls[0][2].signal?.reason).toBe(reason);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not call the transport for a pre-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const callTool = vi.fn(async () => undefined);
    const manager = new McpClientManager([{ type: "stdio", name: "local", command: "node" }], {
      clientFactory: async () => ({ async listTools() { return []; }, async readResource() { return { contents: [] }; }, callTool, async close() {} }),
    });
    await manager.connect();
    await expect(manager.invokeTool("local", "sleep", {}, { signal: controller.signal })).rejects.toBe(reason);
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("401 Unauthorized cancellation", "AbortError"),
    Object.assign(new Error("401 Unauthorized cancellation"), { name: "AbortError", code: 401 }),
  ])("does not recover an AbortError: %s", async (reason) => {
    const recover = vi.fn(async () => true);
    const manager = new McpClientManager([{ type: "stdio", name: "local", command: "node" }], {
      clientFactory: async () => ({ async listTools() { return []; }, async readResource() { return { contents: [] }; }, async callTool() { throw reason; }, async close() {} }),
      onAuthFailure: recover,
    });
    await manager.connect();
    await expect(manager.invokeTool("local", "sleep", {})).rejects.toBe(reason);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not retry when the signal aborts during OAuth recovery", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during refresh");
    const callTool = vi.fn(async () => { throw new Error("401 Unauthorized"); });
    const manager = new McpClientManager([{ type: "http", name: "local", url: "https://example.test/mcp" }], {
      clientFactory: async () => ({ async listTools() { return []; }, async readResource() { return { contents: [] }; }, callTool, async close() {} }),
      onAuthFailure: async () => { controller.abort(reason); return true; },
    });
    await manager.connect();
    await expect(manager.invokeTool("local", "sleep", {}, { signal: controller.signal })).rejects.toBe(reason);
    expect(callTool).toHaveBeenCalledOnce();
  });

  it.each([
    ["numeric 403", Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: 403 })],
    ["string 401", Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: "401" })],
    ["null", null],
    ["undefined", undefined],
  ])("does not refresh non-auth failures: %s", async (_kind, error) => {
    const refresh = vi.fn(async () => true);
    const close = vi.fn(async () => undefined);
    const manager = new McpClientManager(
      [{ type: "http", name: "local", url: "https://example.test/mcp" }],
      {
        clientFactory: async () => ({
          async listTools() { throw error; },
          async readResource() { return { contents: [] }; },
          async callTool() { throw error; },
          close,
        }),
        onAuthFailure: refresh,
      }
    );
    await manager.connect();
    await expect(manager.invokeTool("local", "search", {})).rejects.toBe(error);
    await expect(manager.listTools()).resolves.toEqual([]);
    expect(manager.hasClient("local")).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    await expect(manager.connect()).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    await manager.close();
  });

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
                visibility: ["model" as const, "app" as const],
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ];
          },
          async readResource() { return { contents: [] }; },
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
        async readResource() { return { contents: [] }; },
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
        async readResource() { return { contents: [] }; },
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
        clientFactory: async () => ({ async listTools() { return [{ server: "claap", name: "search", description: "", visibility: ["model" as const, "app" as const], inputSchema: {} }]; }, async readResource() { return { contents: [] }; }, async callTool() { throw new Error("401 Unauthorized"); }, async close() {} }),
        onAuthFailure: async () => false,
        notConnectedResponse: (server) => ({ connected: false, server, reason: "needs_reconnect" }),
      }
    );
    await manager.connect();
    await manager.listTools();
    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ connected: false, server: "claap", reason: "needs_reconnect" });
  });

  it.each([
    { kind: "message-based", phase: "invokeTool", error: new Error("401 Unauthorized") },
    ...["invokeTool", "listTools", "connect", "reconnect"].map((phase) => ({
      kind: "numeric-only", phase,
      error: Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: 401 }),
    })),
  ])("refreshes an expired OAuth transport after a $kind 401 during $phase", async ({ phase, error }) => {
    const tokens = ["expired-token", "fresh-token"];
    const signal = new AbortController().signal;
    const signals: (AbortSignal | undefined)[] = [];
    const close = vi.fn(async () => undefined);
    let reconnecting = false;
    const factory = vi.fn(async (_server, token): Promise<McpClientHandle> => {
      if (token === "expired-token" && (phase === "connect" || (phase === "reconnect" && reconnecting))) throw error;
      return {
        async listTools() {
          if (token === "expired-token" && phase === "listTools") throw error;
          return [{ server: "claap", name: "search", description: "", visibility: ["model" as const, "app" as const], inputSchema: {} }];
        },
        async readResource() { return { contents: [] }; },
        async callTool(_name, _args, options) {
          signals.push(options?.signal);
          if (token === "expired-token") throw error;
          return { token };
        },
        close,
      };
    });
    const refresh = vi.fn(async () => {
      tokens.shift();
      return true;
    });
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      { clientFactory: factory, tokenProvider: async () => tokens[0], onAuthFailure: refresh }
    );

    await manager.connect();
    if (phase === "reconnect") {
      await manager.close();
      reconnecting = true;
      await manager.connect();
    }
    expect(manager.hasClient("claap")).toBe(true);
    await expect(manager.listTools()).resolves.toEqual([
      { server: "claap", name: "search", description: "", visibility: ["model", "app"], inputSchema: {} },
    ]);

    await expect(manager.invokeTool("claap", "search", {}, { signal })).resolves.toEqual({ token: "fresh-token" });
    expect(signals).toEqual(phase === "invokeTool" ? [signal, signal] : [signal]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(factory.mock.calls.map(([, token]) => token)).toEqual(
      phase === "reconnect" ? ["expired-token", "expired-token", "fresh-token"] : ["expired-token", "fresh-token"]
    );
    expect(close).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(manager.getErrors()).toEqual([]);
  });

  it("shares reconnect work across concurrent 401s", async () => {
    let token = "expired-token";
    const factory = vi.fn(async (_server, currentToken): Promise<McpClientHandle> => ({
      async listTools() { return [{ server: "claap", name: "search", description: "", visibility: ["model" as const, "app" as const], inputSchema: {} }]; },
      async readResource() { return { contents: [] }; },
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

  it.each([
    new Error("401 Unauthorized"),
    Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: 401 }),
  ])("marks a still-unauthorized refreshed transport as needing reconnect: %s", async (error) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const terminal = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => true);
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => { throw error; });
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => ({
          async listTools() { return [{ server: "claap", name: "search", description: "", visibility: ["model" as const, "app" as const], inputSchema: {} }]; },
          async readResource() { return { contents: [] }; },
          callTool,
          close,
        }),
        onAuthFailure: refresh,
        notConnectedResponse: (server) => ({ connected: false, server, reason: "needs_reconnect" }),
        onUnrecoverableAuthFailure: terminal,
      }
    );

    await manager.connect();
    await manager.listTools();

    await expect(manager.invoke("claap__search", {})).resolves.toEqual({ connected: false, server: "claap", reason: "needs_reconnect" });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ name: "claap" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(manager.hasClient("claap")).toBe(false);
    expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([expect.objectContaining({ level: "error", reason: "unrecoverable_auth" })]);
  });

  it.each([
    new Error("401 Unauthorized"),
    Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: 401 }),
  ])("marks a still-unauthorized refreshed transport during discovery as needing reconnect: %s", async (error) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const terminal = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => true);
    const close = vi.fn(async () => undefined);
    const listTools = vi.fn(async () => { throw error; });
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => ({
          listTools,
          async readResource() { return { contents: [] }; },
          async callTool() { return undefined; },
          close,
        }),
        onAuthFailure: refresh,
        onUnrecoverableAuthFailure: terminal,
      }
    );

    await manager.connect();

    await expect(manager.listTools()).resolves.toEqual([]);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ name: "claap" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(manager.hasClient("claap")).toBe(false);
    expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([expect.objectContaining({ level: "error", reason: "unrecoverable_auth" })]);
  });

  it.each([
    new Error("401 Unauthorized"),
    Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: "), { code: 401 }),
  ])("marks a refreshed transport that 401s while reconnecting as needing reconnect: %s", async (error) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const terminal = vi.fn(async () => undefined);
    let connections = 0;
    const manager = new McpClientManager(
      [{ type: "http", name: "claap", url: "https://api.claap.io/mcp" }],
      {
        clientFactory: async (): Promise<McpClientHandle> => {
          connections += 1;
          if (connections === 2) throw error;
          return {
            async listTools() { return [{ server: "claap", name: "search", description: "", visibility: ["model" as const, "app" as const], inputSchema: {} }]; },
            async readResource() { return { contents: [] }; },
            async callTool() { throw error; },
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
    expect(connections).toBe(2);
    expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([expect.objectContaining({ level: "error", reason: "unrecoverable_auth" })]);
  });
});
