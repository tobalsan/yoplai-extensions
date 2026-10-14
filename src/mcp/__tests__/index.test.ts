import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import extension, { createMcpExtension } from "../index.js";

/** Re-imports the module so its module-level "warned once" flag starts fresh. */
async function loadFreshModule(): Promise<typeof import("../index.js")> {
  vi.resetModules();
  return import("../index.js");
}

describe("mcp extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_CONFIG_PATH;
    delete process.env.YOPLAI_HOME;
    delete process.env.AIHUB_HOME;
  });

  it("does not expose tools when mcp.json is absent", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));

    await expect(
      extension.getAgentTools?.(
        { id: "casey", workspaceDir: agentDir },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([]);
  });

  it("uses mcp.json even without an enabled flag", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    const mockedExtension = createMcpExtension(async () => ({
      async listTools() { return [{ server: "local", name: "ping", description: "Ping", inputSchema: { type: "object" } }]; },
      async callTool() { return "pong"; },
      async close() {},
    }));
    await expect(
      mockedExtension.getAgentTools?.(
        { id: "casey", workspaceDir: agentDir, extensions: { mcp: {} } },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([expect.objectContaining({ name: "mcp__local__ping" })]);

    expect(
      extension.getSystemPromptContributions?.(
        { id: "casey", workspaceDir: agentDir, extensions: { mcp: {} } },
        { config: { extensions: {} } }
      )
    ).toEqual([expect.stringContaining("MCP tools")]);
    await mockedExtension.stop();
  });

  it("rejects invalid MCP config fields even with enabled false", async () => {
    await expect(
      extension.getAgentTools?.(
        {
          id: "casey",
          workspaceDir: "/tmp/unused",
          extensions: { mcp: { enabled: false, configPath: 123 } },
        },
        { config: { extensions: {} } }
      )
    ).rejects.toThrow("Expected string");
  });

  it("validates invalid MCP config fields without an enabled flag", async () => {
    await expect(
      extension.getAgentTools?.(
        {
          id: "casey",
          workspaceDir: "/tmp/unused",
          extensions: { mcp: { configPath: 123 } },
        },
        { config: { extensions: {} } }
      )
    ).rejects.toThrow("Expected string");

    expect(
      extension.validateAgentConfigs({
        agents: [{ id: "casey", extensions: { mcp: { configPath: 123 } } }],
        extensions: {},
      })
    ).toMatchObject({ valid: false });
  });

  it("validates malformed enabled mcp config fields", () => {
    const result = extension.validateAgentConfigs({
      agents: [
        { id: "casey", extensions: { mcp: { enabled: true, configPath: 123 } } },
      ],
      extensions: {},
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Expected string");
  });

  it("surfaces tools from opted-in mcp.json configs", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, ".env"),
      "MCP_CMD=node\n"
    );
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${MCP_CMD}" } } })
    );

    const connect = vi.fn();
    const callTool = vi.fn(async (_name: string, args: unknown) => args);
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
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
        callTool,
        async close() {},
      };
    });

    const tools = await mockedExtension.getAgentTools(
      {
        id: "casey",
        workspaceDir: agentDir,
        extensions: { mcp: { enabled: true } },
      },
      { config: { extensions: {} } }
    );

    expect(connect).toHaveBeenCalledWith({ type: "stdio", name: "local", command: "node" });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "mcp__local__echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    });
    const signal = new AbortController().signal;
    await expect(tools[0]?.execute({ text: "hi" }, { signal })).resolves.toEqual({ text: "hi" });
    expect(callTool).toHaveBeenCalledWith("echo", { text: "hi" }, { signal });
    await mockedExtension.stop();
  });

  it("forwards the signal through the fresh OAuth-aware manager", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      local: { url: "https://example.test/mcp", oauth: { clientId: "client" } },
    } }));
    const host = credentials();
    const store = new McpOAuthStore(agentDir, "http://localhost/callback", host, () => ({ url: "https://example.test/mcp", clientId: "client" }));
    await store.write("casey", "local", {
      client: { client_id: "client", redirect_uris: ["http://localhost/callback"] },
      tokens: { access_token: "test-token", token_type: "Bearer" }, connectedAt: new Date().toISOString(),
      authorizationServerUrl: "https://auth.example.test", state: "connected",
    });
    const callTool = vi.fn(async (_name: string, args: unknown) => args);
    const factory = vi.fn(async () => ({
      async listTools() { return [{ server: "local", name: "echo", description: "Echo", inputSchema: { type: "object" } }]; },
      callTool, async close() {},
    }));
    const mockedExtension = createMcpExtension(factory);
    const agent = { id: "casey", workspaceDir: agentDir, extensions: { mcp: {} } };
    await mockedExtension.start({ credentials: host, getDataDir: () => agentDir, getConfig: () => ({}), getAgent: () => agent });
    try {
      const tools = await mockedExtension.getAgentTools(agent, { config: {} });
      const signal = new AbortController().signal;
      await expect(tools[0]?.execute({ text: "hi" }, { signal })).resolves.toEqual({ text: "hi" });
      expect(callTool).toHaveBeenCalledWith("echo", { text: "hi" }, { signal });
      expect(factory).toHaveBeenCalledTimes(2);
    } finally { await mockedExtension.stop(); }
  });

  it("uses a valid object schema for disconnected OAuth MCP placeholders", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } })
    );
    const mockedExtension = createMcpExtension(async () => ({
      async listTools() {
        return [];
      },
      async callTool(_name, args) {
        return args;
      },
      async close() {},
    }));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const tools = await mockedExtension.getAgentTools(
      {
        id: "casey",
        workspaceDir: agentDir,
        extensions: { mcp: { enabled: true } },
      },
      { config: { extensions: {} } }
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "mcp__claap__not_connected",
      parameters: { type: "object", additionalProperties: false },
    });
    await mockedExtension.stop();
  });

  it("resolves $env references in mcp extension config paths", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-"));
    const configPath = path.join(configDir, "custom-mcp.json");
    process.env.MCP_CONFIG_PATH = configPath;
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    const connect = vi.fn();
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
      return {
        async listTools() {
          return [
            {
              server: server.name,
              name: "echo",
              description: "Echo input",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool(_name, args) {
          return args;
        },
        async close() {},
      };
    });

    const tools = await mockedExtension.getAgentTools(
      {
        id: "casey",
        extensions: { mcp: { enabled: true, configPath: "$env:MCP_CONFIG_PATH" } },
      },
      { config: { extensions: {} } }
    );

    expect(connect).toHaveBeenCalledWith({ type: "stdio", name: "local", command: "node" });
    expect(tools).toHaveLength(1);
    await mockedExtension.stop();
  });

  it("prefers YOPLAI_HOME over AIHUB_HOME and does not warn", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${MCP_CMD}" } } })
    );
    const newHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-yoplai-home-"));
    fs.writeFileSync(path.join(newHomeDir, ".env"), "MCP_CMD=from-yoplai-home\n");
    const legacyHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-aihub-home-"));
    fs.writeFileSync(path.join(legacyHomeDir, ".env"), "MCP_CMD=from-aihub-home\n");
    process.env.YOPLAI_HOME = newHomeDir;
    process.env.AIHUB_HOME = legacyHomeDir;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connect = vi.fn();
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
      return { async listTools() { return []; }, async callTool() { return undefined; }, async close() {} };
    });

    await mockedExtension.getAgentTools(
      { id: "casey", workspaceDir: agentDir, extensions: { mcp: { enabled: true } } },
      { config: { extensions: {} } }
    );

    expect(connect).toHaveBeenCalledWith({ type: "stdio", name: "local", command: "from-yoplai-home" });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("AIHUB_HOME"));
    await mockedExtension.stop();
  });

  it("falls back to legacy AIHUB_HOME and warns at most once", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${MCP_CMD}" } } })
    );
    const legacyHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-aihub-home-"));
    fs.writeFileSync(path.join(legacyHomeDir, ".env"), "MCP_CMD=from-aihub-home\n");
    process.env.AIHUB_HOME = legacyHomeDir;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connect = vi.fn();
    const { createMcpExtension: createFreshExtension } = await loadFreshModule();
    const mockedExtension = createFreshExtension(async (server) => {
      connect(server);
      return { async listTools() { return []; }, async callTool() { return undefined; }, async close() {} };
    });
    const agent = { id: "casey", workspaceDir: agentDir, extensions: { mcp: { enabled: true } } };
    const context = { config: { extensions: {} } };

    await mockedExtension.getAgentTools(agent, context);
    await mockedExtension.getAgentTools({ ...agent, id: "morgan" }, context);

    expect(connect).toHaveBeenCalledWith({ type: "stdio", name: "local", command: "from-aihub-home" });
    const legacyWarnings = warnSpy.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("AIHUB_HOME")
    );
    expect(legacyWarnings).toHaveLength(1);
    await mockedExtension.stop();
  });

  it("falls back to legacy AIHUB_HOME and warns when YOPLAI_HOME is empty", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${MCP_CMD}" } } })
    );
    const legacyHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-aihub-home-"));
    fs.writeFileSync(path.join(legacyHomeDir, ".env"), "MCP_CMD=from-aihub-home\n");
    process.env.YOPLAI_HOME = "";
    process.env.AIHUB_HOME = legacyHomeDir;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connect = vi.fn();
    const { createMcpExtension: createFreshExtension } = await loadFreshModule();
    const mockedExtension = createFreshExtension(async (server) => {
      connect(server);
      return { async listTools() { return []; }, async callTool() { return undefined; }, async close() {} };
    });

    await mockedExtension.getAgentTools(
      { id: "casey", workspaceDir: agentDir, extensions: { mcp: { enabled: true } } },
      { config: { extensions: {} } }
    );

    expect(connect).toHaveBeenCalledWith({ type: "stdio", name: "local", command: "from-aihub-home" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("AIHUB_HOME"));
    await mockedExtension.stop();
  });

  it("treats a whitespace-only AIHUB_HOME as unset: no warning, no home dir", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${MCP_CMD}" } } })
    );
    // Whitespace-only, not "", so a non-trimming fallback would still see it as set.
    process.env.AIHUB_HOME = "   ";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connect = vi.fn();
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
      return { async listTools() { return []; }, async callTool() { return undefined; }, async close() {} };
    });

    await mockedExtension.getAgentTools(
      { id: "casey", workspaceDir: agentDir, extensions: { mcp: { enabled: true } } },
      { config: { extensions: {} } }
    );

    // No home dir means MCP_CMD is never defined, so the server fails to resolve.
    expect(connect).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('server "local" unavailable'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("AIHUB_HOME"));
    await mockedExtension.stop();
  });

  it("reuses connected managers and closes them on stop", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    const close = vi.fn(async () => undefined);
    const connect = vi.fn();
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
      return {
        async listTools() {
          return [
            {
              server: server.name,
              name: "echo",
              description: "Echo input",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool(_name, args) {
          return args;
        },
        close,
      };
    });

    const agent = {
      id: "casey",
      workspaceDir: agentDir,
      extensions: { mcp: { enabled: true } },
    };
    const context = { config: { extensions: {} } };

    await mockedExtension.getAgentTools(agent, context);
    await mockedExtension.getAgentTools(agent, context);
    expect(connect).toHaveBeenCalledOnce();

    await mockedExtension.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("shares an in-flight manager for concurrent discovery calls", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    const close = vi.fn(async () => undefined);
    const connect = vi.fn();
    const mockedExtension = createMcpExtension(async (server) => {
      connect(server);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        async listTools() {
          return [
            {
              server: server.name,
              name: "echo",
              description: "Echo input",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool(_name, args) {
          return args;
        },
        close,
      };
    });
    const agent = {
      id: "casey",
      workspaceDir: agentDir,
      extensions: { mcp: { enabled: true } },
    };
    const context = { config: { extensions: {} } };

    await Promise.all([
      mockedExtension.getAgentTools(agent, context),
      mockedExtension.getAgentTools(agent, context),
    ]);
    expect(connect).toHaveBeenCalledOnce();

    await mockedExtension.stop();
    expect(close).toHaveBeenCalledOnce();
  });
});
