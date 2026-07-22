import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

import { McpClientManager, type McpClientFactory } from "./client-manager.js";
import { loadMcpConfigFile, type LoadedMcpConfig, type McpServerConfig } from "./loader.js";
import { adaptMcpTools } from "./tool-adapter.js";
import { McpOAuthStore } from "./oauth.js";
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
  advancedConfigFields: ["configPath", "agentDir"],
  configRoute: { path: "/agents/:agentId/extensions/mcp" },
  createTools() {
    return [];
  },
});

export function createMcpExtension(clientFactory?: McpClientFactory) {
  const managers = new Map<string, Promise<McpClientManager>>();
  const oauthServers = new Set<string>();
  let runtime: { getDataDir(): string; getConfig(): { extensions?: Record<string, unknown>; env?: Record<string, string> }; getAgent(id: string): AgentLike | undefined } | undefined;
  const redirectUri = `${(process.env.AIHUB_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "")}/api/mcp/oauth/callback`;
  let oauth: McpOAuthStore | undefined;

  function loadedForAgent(agentId: string): LoadedMcpConfig | undefined {
    const agent = runtime?.getAgent(agentId);
    if (!agent || !runtime) return undefined;
    const root = runtime.getConfig();
    const resolved = { global: {}, root: {}, agent: {}, merged: {} };
    const configPath = resolveConfigPath(agent, resolved);
    if (!fs.existsSync(configPath)) return undefined;
    return loadMcpConfigFile(configPath, resolveInterpolationEnv(agent, root, resolved));
  }

  function html(server: string, success: boolean, message: string): string {
    return `<!doctype html><title>MCP OAuth</title><p>${message}</p><script>window.opener?.postMessage({type:"aihub-oauth",extension:"mcp",server:${JSON.stringify(server)},success:${success}},"*")</script>`;
  }

  async function isOAuthServer(agent: string, server: Extract<McpServerConfig, { type: "http" }>): Promise<boolean> {
    const key = `${agent}:${server.name}`;
    if (oauthServers.has(key) || await oauth?.read(agent, server.name)) return true;
    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "oauth-detection", method: "initialize", params: {} }),
      });
      if (response.status === 401) oauthServers.add(key);
    } catch {
      // Connection failures are not evidence that this server uses OAuth.
    }
    return oauthServers.has(key);
  }

  async function resetManagers(agent: string): Promise<void> {
    const keys = [...managers.keys()].filter((key) => key.startsWith(`${agent}:`));
    await Promise.all(keys.map(async (key) => {
      const manager = await managers.get(key);
      managers.delete(key);
      await manager?.close();
    }));
  }

  async function getManager(
    key: string,
    agentId: string,
    servers: LoadedMcpConfig["servers"]
  ): Promise<McpClientManager> {
    const cached = managers.get(key);
    if (cached) return cached;
    const managerPromise = (async () => {
      const manager = new McpClientManager(
        servers,
        clientFactory,
        async (server) => server.type === "http" && !server.headers && oauth && await isOAuthServer(agentId, server)
          ? oauth.accessToken(agentId, server.name)
          : undefined,
        async (server) => {
          if (server.type === "http" && !server.headers) {
            oauthServers.add(`${agentId}:${server.name}`);
            await oauth?.markNeedsReconnect(agentId, server.name);
          }
        },
        async (server) => server.type === "http" && !server.headers && await isOAuthServer(agentId, server),
        (server) => ({ connected: false, provider: "mcp", server, reason: "needs_reconnect", message: `${server} is not connected. Ask an admin to connect it in the agent settings.`, authorizeUrl: `/agents/${agentId}/extensions/mcp` })
      );
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
  async start(ctx: { getDataDir(): string; getConfig(): { extensions?: Record<string, unknown>; env?: Record<string, string> }; getAgent(id: string): AgentLike | undefined }) {
    runtime = ctx;
    oauth = new McpOAuthStore(ctx.getDataDir(), redirectUri);
  },
  registerRoutes(app: any) {
    app.get("/mcp/oauth/status", async (c: any) => {
      const agent = c.req.query("agent");
      const loaded = agent ? loadedForAgent(agent) : undefined;
      if (!agent || !loaded || !oauth) return c.json({ servers: [] });
      const store = oauth;
      const servers = await Promise.all(loaded.servers.filter((server): server is Extract<McpServerConfig, { type: "http" }> => server.type === "http").map(async (server) => {
        if (server.headers) return { name: server.name, url: server.url, auth: "static", state: "static" };
        if (!await isOAuthServer(agent, server)) return { name: server.name, url: server.url, auth: "static", state: "static" };
        const connection = await store.read(agent, server.name);
        return { name: server.name, url: server.url, auth: "oauth", state: connection?.state === "needs_reconnect" ? "needs_reconnect" : connection ? "connected" : "disconnected", ...(connection ? { connectedAt: connection.connectedAt, expiresAt: connection.expiresAt } : {}) };
      }));
      return c.json({ servers });
    });
    app.get("/mcp/oauth/authorize", async (c: any) => {
      const agent = c.req.query("agent");
      const name = c.req.query("server");
      const server = agent && name ? loadedForAgent(agent)?.servers.find((item): item is Extract<McpServerConfig, { type: "http" }> => item.type === "http" && item.name === name) : undefined;
      if (!agent || !server || server.headers || !oauth) return c.text("Unknown OAuth MCP server", 404);
      try { return c.redirect((await oauth.begin(agent, server.name, server.url)).authorizationUrl); }
      catch (error) { return c.text(error instanceof Error ? error.message : String(error), 400); }
    });
    app.get("/mcp/oauth/callback", async (c: any) => {
      const code = c.req.query("code"); const state = c.req.query("state");
      if (!code || !state || !oauth) return c.html(html("", false, "OAuth connection failed"), 400);
      try { const flow = await oauth.finish(state, code); oauthServers.add(`${flow.agent}:${flow.server}`); await resetManagers(flow.agent); return c.html(html(flow.server, true, "MCP server connected")); }
      catch (error) { return c.html(html("", false, error instanceof Error ? error.message : "OAuth connection failed"), 400); }
    });
    app.post("/mcp/oauth/disconnect", async (c: any) => {
      const agent = c.req.query("agent"); const name = c.req.query("server");
      if (!agent || !name || !oauth) return c.json({ ok: true });
      await oauth.revoke(agent, name);
      await oauth.delete(agent, name);
      oauthServers.add(`${agent}:${name}`);
      await resetManagers(agent);
      return c.json({ ok: true });
    });
  },
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
    const manager = await getManager(`${agent.id}:${configPath}`, agent.id, loaded.servers);
    const tools = adaptMcpTools(await manager.listTools(), manager);
    const connectedTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchemaParameters ?? {},
      execute: (params: unknown) => tool.execute(params),
    }));
    const disconnected = await Promise.all(loaded.servers.filter((server): server is Extract<McpServerConfig, { type: "http" }> => server.type === "http" && !server.headers).map(async (server) => {
      if (!await isOAuthServer(agent.id, server) || await oauth?.accessToken(agent.id, server.name)) return undefined;
      return {
        name: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, "_")}__not_connected`,
        description: `Connect ${server.name} in the MCP extension settings before using its tools.`,
        parameters: {},
        execute: async () => ({ connected: false, provider: "mcp", server: server.name, reason: "not_connected", message: `${server.name} is not connected. Ask an admin to connect it in the agent settings.`, authorizeUrl: `/agents/${agent.id}/extensions/mcp` }),
      };
    }));
    return [...connectedTools, ...disconnected.filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))];
  },
  };
}

export default createMcpExtension();

export { parseMcpConfig, loadMcpConfigFile } from "./loader.js";
export { McpClientManager } from "./client-manager.js";
export { adaptMcpTools, getMcpExtensionToolName } from "./tool-adapter.js";
