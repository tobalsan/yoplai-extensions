import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

import { McpClientManager, type McpClientFactory } from "./client-manager.js";
import { loadMcpConfigFile, type LoadedMcpConfig, type McpServerConfig } from "./loader.js";
import { adaptMcpTools } from "./tool-adapter.js";
import { McpOAuthStore, type ScopedCredentials, type CredentialScope } from "./oauth.js";
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

type RouteContext = {
  get?(name: string): unknown;
  req: { query(name: string): string | undefined };
  json(body: unknown): unknown;
  text(body: string, status?: number): unknown;
  html(body: string, status?: number): unknown;
  redirect(url: string): unknown;
};

type RouteHandler = (context: RouteContext) => unknown | Promise<unknown>;

type RouteApp = {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
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

function resolveExtensionConfig(
  agent: AgentLike,
  rootConfig: { extensions?: Record<string, unknown> }
): ResolvedToolExtensionConfig {
  const resolved = McpExtensionConfigSchema.parse({
    ...resolveConfigRecord(rootConfig.extensions?.mcp),
    ...resolveConfigRecord(agent.extensions?.mcp),
  });
  return { global: {}, root: {}, agent: resolved, merged: resolved };
}

let warnedLegacyHomeEnv = false;

function trimValue(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function resolveInterpolationEnv(
  agent: AgentLike,
  rootConfig: { env?: Record<string, string> },
  resolved: ResolvedToolExtensionConfig
): Record<string, string> {
  const agentDir = resolveAgentDir(agent, resolved);
  const legacyHomeDir = trimValue(process.env.AIHUB_HOME);
  const homeDir = trimValue(process.env.YOPLAI_HOME) ?? legacyHomeDir;
  if (!trimValue(process.env.YOPLAI_HOME) && legacyHomeDir && !warnedLegacyHomeEnv) {
    warnedLegacyHomeEnv = true;
    console.warn("[mcp] AIHUB_HOME is deprecated; set YOPLAI_HOME instead.");
  }
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

type McpRuntimeConfig = { extensions?: Record<string, unknown>; env?: Record<string, string>; server?: { baseUrl?: string } };
export type McpRuntime = { credentials?: ScopedCredentials; getDataDir(): string; getConfig(): McpRuntimeConfig; getAgent(id: string): AgentLike | undefined };

/**
 * OAuth providers behind a WAF (e.g. TradingView/CloudFront) reject localhost redirect URIs outright,
 * so prefer a public origin: explicit BASE_URL, then the gateway's configured server.baseUrl, then localhost.
 */
export function resolveOAuthRedirectUri(config: McpRuntimeConfig): string {
  const origin = process.env.BASE_URL?.trim() || config.env?.BASE_URL?.trim() || config.server?.baseUrl?.trim() || "http://localhost:4000";
  return `${origin.replace(/\/+$/, "")}/api/mcp/oauth/callback`;
}

export function createMcpExtension(clientFactory?: McpClientFactory) {
  const managers = new Map<string, Promise<McpClientManager>>();
  const oauthServers = new Set<string>();
  let runtime: McpRuntime | undefined;
  let oauth: McpOAuthStore | undefined;

  function loadedForAgent(agentId: string): LoadedMcpConfig | undefined {
    const agent = runtime?.getAgent(agentId);
    if (!agent || !runtime) return undefined;
    const root = runtime.getConfig();
    const resolved = resolveExtensionConfig(agent, root);
    const configPath = resolveConfigPath(agent, resolved);
    if (!fs.existsSync(configPath)) return undefined;
    return loadMcpConfigFile(configPath, resolveInterpolationEnv(agent, root, resolved));
  }

  function html(server: string, success: boolean, message: string): string {
    return `<!doctype html><title>MCP OAuth</title><p>${message}</p><script>window.opener?.postMessage({type:"yoplai-oauth",extension:"mcp",server:${JSON.stringify(server)},success:${success}},"*")</script>`;
  }

  async function isOAuthServer(agent: string, server: Extract<McpServerConfig, { type: "http" }>): Promise<boolean> {
    const key = `${agent}:${server.name}`;
    if (server.oauth) return true;
    if (oauthServers.has(key) || await oauth?.read(agent, server.name)) return true;
    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
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
    servers: LoadedMcpConfig["servers"],
    requesterUserId?: string
  ): Promise<McpClientManager> {
    const cached = managers.get(key);
    if (cached) return cached;
    const managerPromise = (async () => {
      const selectedScopes = new Map<string, CredentialScope>();
      const manager = new McpClientManager(
        servers,
        clientFactory,
        async (server) => {
          if (server.type !== "http" || server.headers || !oauth || !await isOAuthServer(agentId, server)) return undefined;
          const selected = await oauth.resolve(agentId, server.name, requesterUserId);
          if (!selected) return undefined;
          selectedScopes.set(server.name, selected.scope);
          return oauth.accessToken(agentId, server.name, 60_000, requesterUserId, selected.scope);
        },
        async (server) => {
          if (server.type === "http" && !server.headers) {
            oauthServers.add(`${agentId}:${server.name}`);
            const scope = selectedScopes.get(server.name);
            return scope ? Boolean(await oauth?.refreshAccessToken(agentId, server.name, requesterUserId, scope)) : false;
          }
          return false;
        },
        async (server) => server.type === "http" && !server.headers && await isOAuthServer(agentId, server),
        (server) => ({ connected: false, provider: "mcp", server, reason: "needs_reconnect", message: `${server} is not connected. Connect it using your own MCP connection settings.`, authorizeUrl: `/agents/${encodeURIComponent(agentId)}/extensions/mcp?scope=personal&server=${encodeURIComponent(server)}` }),
        async (server) => {
          if (server.type === "http" && !server.headers) {
            const scope = selectedScopes.get(server.name);
            if (scope) await oauth?.markNeedsReconnect(agentId, server.name, scope);
          }
        }
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
  async start(ctx: McpRuntime) {
    runtime = ctx;
    oauth = new McpOAuthStore(ctx.getDataDir(), resolveOAuthRedirectUri(ctx.getConfig()), ctx.credentials);
  },
  registerRoutes(app: RouteApp) {
    function multiUserEnabled(): boolean {
      const config = runtime?.getConfig().extensions?.multiUser;
      return isRecord(config) && config.enabled === true;
    }
    function userId(c: RouteContext): string | undefined {
      const auth = c.get?.("multiUserAuthContext");
      return isRecord(auth) && isRecord(auth.user) && typeof auth.user.id === "string" ? auth.user.id : undefined;
    }
    // Team grants act for everyone, so only staff may set or remove them.
    function canConfigureTeam(c: RouteContext): boolean {
      if (!multiUserEnabled()) return true;
      const auth = c.get?.("multiUserAuthContext");
      const role = isRecord(auth) && isRecord(auth.user) ? auth.user.role : undefined;
      const roles = Array.isArray(role) ? role : [role];
      return roles.some((r) => r === "admin" || r === "superadmin");
    }
    function requestedScope(c: RouteContext): CredentialScope | undefined {
      const id = userId(c);
      if (c.req.query("scope") === "team" && (id || !multiUserEnabled())) return { type: "team" };
      if (!id) return undefined;
      if (c.req.query("scope") === "personal") return { type: "personal", userId: id };
      return undefined;
    }
    app.get("/mcp/oauth/status", async (c) => {
      const scope = requestedScope(c);
      if (!scope) return c.text("Authenticated credential scope required", 400);
      const agent = c.req.query("agent");
      const loaded = agent ? loadedForAgent(agent) : undefined;
      if (!agent || !loaded || !oauth) return c.json({ servers: [] });
      const store = oauth;
      const servers = await Promise.all(loaded.servers.filter((server): server is Extract<McpServerConfig, { type: "http" }> => server.type === "http").map(async (server) => {
        if (server.headers) return { name: server.name, url: server.url, auth: "static", state: "static" };
        if (!await isOAuthServer(agent, server)) return { name: server.name, url: server.url, auth: "static", state: "static" };
        const connection = await store.read(agent, server.name, scope);
        return { name: server.name, url: server.url, auth: "oauth", state: connection?.state === "needs_reconnect" ? "needs_reconnect" : connection ? "connected" : "disconnected", ...(connection ? { connectedAt: connection.connectedAt, expiresAt: connection.expiresAt } : {}) };
      }));
      return c.json({ servers, canConfigureTeam: canConfigureTeam(c) });
    });
    app.get("/mcp/oauth/authorize", async (c) => {
      const agent = c.req.query("agent");
      const name = c.req.query("server");
      const server = agent && name ? loadedForAgent(agent)?.servers.find((item): item is Extract<McpServerConfig, { type: "http" }> => item.type === "http" && item.name === name) : undefined;
      if (!agent || !server || server.headers || !oauth) return c.text("Unknown OAuth MCP server", 404);
      if (!userId(c) && multiUserEnabled()) return c.text("Authentication required", 401);
      const scope = requestedScope(c);
      if (!scope) {
        if (c.req.query("scope")) return c.text("Invalid credential scope", 400);
        const base = `/api/mcp/oauth/authorize?agent=${encodeURIComponent(agent)}&server=${encodeURIComponent(server.name)}`;
        return c.html(`<!doctype html><title>Connect MCP</title><h1>Who can use this connection?</h1><a href="${base}&scope=personal">Just me</a>${canConfigureTeam(c) ? ` <a href="${base}&scope=team">Whole team</a>` : ""}`);
      }
      if (scope.type === "team" && !canConfigureTeam(c)) return c.text("Only admins can manage team connections", 403);
      try { return c.redirect((await oauth.begin(agent, server.name, server.url, server.oauth, scope)).authorizationUrl); }
      catch (error) { return c.text(error instanceof Error ? error.message : String(error), 400); }
    });
    app.get("/mcp/oauth/callback", async (c) => {
      const code = c.req.query("code"); const state = c.req.query("state");
      if (!code || !state || !oauth) return c.html(html("", false, "OAuth connection failed"), 400);
      try { const flow = await oauth.finish(state, code); oauthServers.add(`${flow.agent}:${flow.server}`); await resetManagers(flow.agent); return c.html(html(flow.server, true, "MCP server connected")); }
      catch (error) { return c.html(html("", false, error instanceof Error ? error.message : "OAuth connection failed"), 400); }
    });
    app.post("/mcp/oauth/disconnect", async (c) => {
      const scope = requestedScope(c);
      if (!scope) return c.text("Authenticated credential scope required", 400);
      if (scope.type === "team" && !canConfigureTeam(c)) return c.text("Only admins can manage team connections", 403);
      const agent = c.req.query("agent"); const name = c.req.query("server");
      if (!agent || !name || !oauth) return c.json({ ok: true });
      await oauth.revoke(agent, name, scope);
      await oauth.delete(agent, name, scope);
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
  async getAgentTools(agent: AgentLike, context?: { userId?: string; config: { extensions?: Record<string, unknown>; env?: Record<string, string> } }) {
    if (!context) return [];
    if (!isRecord(agent.extensions?.mcp) || agent.extensions.mcp.enabled !== true) {
      return [];
    }
    const extensionConfig = resolveExtensionConfig(agent, context.config);
    const configPath = resolveConfigPath(agent, extensionConfig);
    if (!fs.existsSync(configPath)) return [];

    const loaded = loadMcpConfigFile(
      configPath,
      resolveInterpolationEnv(agent, context.config, extensionConfig)
    );
    logConfigErrors(loaded);
    const manager = await getManager(`${agent.id}:${configPath}:${context.userId ?? "anonymous"}`, agent.id, loaded.servers, context.userId);
    const definitions = await manager.listTools();
    const tools = adaptMcpTools(definitions, manager);
    const connectedTools = tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchemaParameters ?? {},
      execute: async (params: unknown, execution?: { userId?: string }) => {
        const definition = definitions[index]!;
        const target = loaded.servers.find((server) => server.name === definition.server)!;
        if (target.type !== "http" || target.headers || !await isOAuthServer(agent.id, target)) return tool.execute(params);
        const requester = execution?.userId;
        const key = `${agent.id}:${configPath}:${requester ?? "anonymous"}:${crypto.randomUUID()}`;
        const fresh = await getManager(key, agent.id, [target], requester);
        try {
          const current = (await fresh.listTools()).find((entry) => entry.name === definition.name && entry.server === definition.server);
          if (current) return await fresh.invokeTool(current.server, current.name, params);
          return { connected: false, provider: "mcp", reason: "not_connected", message: "Connect this MCP server using your own connection settings.", authorizeUrl: `/agents/${encodeURIComponent(agent.id)}/extensions/mcp?scope=personal` };
        } finally { managers.delete(key); await fresh.close(); }
      },
    }));
    const disconnected = await Promise.all(loaded.servers.filter((server): server is Extract<McpServerConfig, { type: "http" }> => server.type === "http" && !server.headers).map(async (server) => {
      if (!await isOAuthServer(agent.id, server) || await oauth?.accessToken(agent.id, server.name, 60_000, context.userId)) return undefined;
      return {
        name: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, "_")}__not_connected`,
        description: `Connect ${server.name} in the MCP extension settings before using its tools.`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ connected: false, provider: "mcp", server: server.name, reason: "not_connected", message: `${server.name} is not connected. Connect it using your own MCP connection settings.`, authorizeUrl: `/agents/${encodeURIComponent(agent.id)}/extensions/mcp?scope=personal` }),
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
