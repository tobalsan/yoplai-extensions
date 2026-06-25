import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import extension, { createMcpExtension } from "../index.js";

describe("mcp extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_CONFIG_PATH;
  });

  it("ignores mcp.json unless the agent opts in", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    await expect(
      extension.getAgentTools?.(
        { id: "casey", workspaceDir: agentDir },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([]);
  });

  it("requires enabled true to opt in", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-"));
    fs.writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node" } } })
    );

    await expect(
      extension.getAgentTools?.(
        { id: "casey", workspaceDir: agentDir, extensions: { mcp: {} } },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([]);

    expect(
      extension.getSystemPromptContributions?.(
        { id: "casey", workspaceDir: agentDir, extensions: { mcp: {} } },
        { config: { extensions: {} } }
      )
    ).toBeUndefined();
  });

  it("ignores invalid mcp config fields when the agent disables MCP", async () => {
    await expect(
      extension.getAgentTools?.(
        {
          id: "casey",
          workspaceDir: "/tmp/unused",
          extensions: { mcp: { enabled: false, configPath: 123 } },
        },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([]);
  });

  it("ignores invalid mcp config fields when enabled is omitted", async () => {
    await expect(
      extension.getAgentTools?.(
        {
          id: "casey",
          workspaceDir: "/tmp/unused",
          extensions: { mcp: { configPath: 123 } },
        },
        { config: { extensions: {} } }
      )
    ).resolves.toEqual([]);

    expect(
      extension.validateAgentConfigs({
        agents: [{ id: "casey", extensions: { mcp: { configPath: 123 } } }],
        extensions: {},
      })
    ).toEqual({ valid: true, errors: [] });
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
    await expect(tools[0]?.execute({ text: "hi" })).resolves.toEqual({ text: "hi" });
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
