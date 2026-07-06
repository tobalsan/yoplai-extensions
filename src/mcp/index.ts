import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

import { McpClientManager, type McpClientFactory } from "./client-manager.js";
import { loadMcpConfigFile, type LoadedMcpConfig } from "./loader.js";
import { adaptMcpTools } from "./tool-adapter.js";
import { defineToolExtension, type ResolvedToolExtensionConfig } from "../tool-extension.js";

const McpExtensionConfigSchema = z
  .object({
    configPath: z
      .string()
      .optional()
      .describe(
        "Path to the MCP servers config JSON (mcpServers map). Defaults to mcp.json in the agent directory."
      ),
    agentDir: z
      .string()
      .optional()
      .describe(
        "Directory used to resolve configPath and load a per-agent .env file. Defaults to the agent's workspace directory."
      ),
  })
  .passthrough();

type AgentLike = {
  id: string;
  workspace?: string;
  workspaceDir?: string;
  extensions?: Record<string, unknown>;
};

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    Object.entries(parseEnv(fs.readFileSync(filePath, "utf8"))).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function processEnvRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$env:")) {
    const envName = value.slice("$env:".length);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(`Env var "${envName}" not set`);
    }
    return envValue;
  }
  if (Array.isArray(value)) return value.map(resolveEnvRefs);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvRefs(item)])
    );
  }
  return value;
}

function resolveConfigRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (resolveEnvRefs(value) as Record<string, unknown>) : {};
}

function resolveAgentDir(agent: AgentLike, config: ResolvedToolExtensionConfig): string {
  const configured = config.merged.agentDir;
  if (typeof configured === "string") return configured;
  if (agent.workspaceDir) return agent.workspaceDir;
  if (agent.workspace) return agent.workspace;
  return process.cwd();
}

function resolveConfigPath(agent: AgentLike, config: ResolvedToolExtensionConfig): string {
  const configured = config.merged.configPath;
  if (typeof configured === "string") return configured;
  return path.join(resolveAgentDir(agent, config), "mcp.json");
}

function resolveInterpolationEnv(
  agent: AgentLike,
  rootConfig: { env?: Record<string, string> },
  resolved: ResolvedToolExtensionConfig
): Record<string, string> {
  const agentDir = resolveAgentDir(agent, resolved);
  const homeDir = process.env.AIHUB_HOME;
  return {
    ...processEnvRecord(),
    ...(rootConfig.env ?? {}),
    ...(homeDir ? readEnvFile(path.join(homeDir, ".env")) : {}),
    ...readEnvFile(path.join(agentDir, ".env")),
  };
}

function logConfigErrors(loaded: LoadedMcpConfig): void {
  for (const error of loaded.errors) {
    console.warn(`[mcp] server "${error.server}" unavailable: ${error.message}`);
  }
}

const baseExtension = defineToolExtension({
  id: "mcp",
  displayName: "MCP",
  description: "Connects standard Model Context Protocol servers from mcp.json.",
  systemPrompt:
    "Use MCP tools when they match the user's task. MCP tool names include the source server to avoid collisions.",
  configSchema: McpExtensionConfigSchema,
  agentConfigSchema: McpExtensionConfigSchema,
  requiredSecrets: [],
  createTools() {
    return [];
  },
});

export function createMcpExtension(clientFactory?: McpClientFactory) {
  const managers = new Map<string, Promise<McpClientManager>>();

  async function getManager(
    key: string,
    servers: LoadedMcpConfig["servers"]
  ): Promise<McpClientManager> {
    const cached = managers.get(key);
    if (cached) return cached;
    const managerPromise = (async () => {
      const manager = new McpClientManager(servers, clientFactory);
      await manager.connect();
      return manager;
    })();
    managers.set(key, managerPromise);
    try {
      return await managerPromise;
    } catch (error) {
      managers.delete(key);
      throw error;
    }
  }

  return {
  ...baseExtension,
  getSystemPromptContributions(agent: AgentLike, context?: { config: { extensions?: Record<string, unknown> } }) {
    if (!context) return undefined;
    if (!isRecord(agent.extensions?.mcp) || agent.extensions.mcp.enabled !== true) {
      return undefined;
    }
    return baseExtension.getSystemPromptContributions(agent, context);
  },
  validateAgentConfigs(config: { agents: AgentLike[]; extensions?: Record<string, unknown> }) {
    const errors: string[] = [];
    for (const agent of config.agents) {
      if (!isRecord(agent.extensions?.mcp) || agent.extensions.mcp.enabled !== true) {
        continue;
      }
      try {
        McpExtensionConfigSchema.parse({
          ...resolveConfigRecord(config.extensions?.mcp),
          ...resolveConfigRecord(agent.extensions.mcp),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { valid: errors.length === 0, errors };
  },
  async stop() {
    const resolvedManagers = await Promise.all([...managers.values()]);
    await Promise.all(resolvedManagers.map((manager) => manager.close()));
    managers.clear();
    await baseExtension.stop();
  },
  async getAgentTools(agent: AgentLike, context?: { config: { extensions?: Record<string, unknown>; env?: Record<string, string> } }) {
    if (!context) return [];
    if (!isRecord(agent.extensions?.mcp) || agent.extensions.mcp.enabled !== true) {
      return [];
    }
    const resolved = McpExtensionConfigSchema.parse({
      ...resolveConfigRecord(context.config.extensions?.mcp),
      ...resolveConfigRecord(agent.extensions?.mcp),
    });
    const extensionConfig = {
      global: {},
      root: {},
      agent: resolved,
      merged: resolved,
    };
    const configPath = resolveConfigPath(agent, extensionConfig);
    if (!fs.existsSync(configPath)) return [];

    const loaded = loadMcpConfigFile(
      configPath,
      resolveInterpolationEnv(agent, context.config, extensionConfig)
    );
    logConfigErrors(loaded);
    const manager = await getManager(`${agent.id}:${configPath}`, loaded.servers);
    const tools = adaptMcpTools(await manager.listTools(), manager);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchemaParameters ?? {},
      execute: (params: unknown) => tool.execute(params),
    }));
  },
  };
}

export default createMcpExtension();

export { parseMcpConfig, loadMcpConfigFile } from "./loader.js";
export { McpClientManager } from "./client-manager.js";
export { adaptMcpTools, getMcpExtensionToolName } from "./tool-adapter.js";
