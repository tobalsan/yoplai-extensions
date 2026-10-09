import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

import { McpClientManager, type McpClientFactory } from "./client-manager.js";
import { parseMcpConfig, type LoadedMcpConfig, type McpServerConfig } from "./loader.js";
import { adaptMcpTools } from "./tool-adapter.js";
import { createIconResolver, knownServer, siteLabel } from "./icon.js";
import { McpOAuthStore, hasProtectedResourceAuthServers, type ScopedCredentials, type CredentialScope, type AuditActor } from "./oauth.js";
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
  req: { query(name: string): string | undefined; json?(): Promise<unknown> };
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

function readRawConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return { mcpServers: {} };
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) throw new Error("Invalid mcp.json: mcpServers must be an object");
  return raw;
}

function writeRawConfig(filePath: string, config: Record<string, unknown>): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const MASK = "••••••••";

const EditableHttpServerSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    oauth: z
      .object({ clientId: z.string().min(1), clientSecret: z.string().min(1).optional(), scopes: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .passthrough();

function maskValues(values: unknown): unknown {
  return isRecord(values) ? Object.fromEntries(Object.keys(values).map((key) => [key, MASK])) : values;
}

/** Copy of a raw server entry that is safe to show: header/env values and OAuth client secret are masked. */
function maskServerConfig(server: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...server };
  if ("headers" in masked) masked.headers = maskValues(masked.headers);
  if ("env" in masked) masked.env = maskValues(masked.env);
  if (isRecord(masked.oauth) && "clientSecret" in masked.oauth) masked.oauth = { ...masked.oauth, clientSecret: MASK };
  return masked;
}

function restoreMasked(submitted: unknown, original: unknown, label: string): unknown {
  if (!isRecord(submitted)) return submitted;
  const source = isRecord(original) ? original : {};
  return Object.fromEntries(Object.entries(submitted).map(([key, value]) => {
    if (value !== MASK) return [key, value];
    if (typeof source[key] !== "string") throw new Error(`${label} "${key}" has no stored value to keep; enter a new value`);
    return [key, source[key]];
  }));
}

function validateEditedHttpServer(submitted: unknown, original: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(submitted)) throw new Error("Server config must be a JSON object");
  for (const field of ["command", "args", "env"]) {
    if (field in submitted) throw new Error(`"${field}" is not allowed; only HTTP servers are editable`);
  }
  const next: Record<string, unknown> = { ...submitted };
  if ("headers" in next) next.headers = restoreMasked(next.headers, original.headers, "Header");
  if (isRecord(next.oauth) && next.oauth.clientSecret === MASK) {
    const secret = isRecord(original.oauth) ? original.oauth.clientSecret : undefined;
    if (typeof secret !== "string") throw new Error("oauth.clientSecret has no stored value to keep; enter a new value");
    next.oauth = { ...next.oauth, clientSecret: secret };
  }
  const parsed = EditableHttpServerSchema.safeParse(next);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; "));
  const url = new URL(parsed.data.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url must be HTTP or HTTPS without embedded credentials");
  if (original.yoplaiManaged === true) next.yoplaiManaged = true;
  for (const field of ["displayName", "description"]) if (!(field in next) && typeof original[field] === "string") next[field] = original[field];
  return next;
}

/** Persists the server-reported label once, for UI-added servers only. */
function saveLabel(filePath: string, name: string, label: { title?: string; description?: string }): void {
  try {
    const root = readRawConfig(filePath);
    const entry = isRecord(root.mcpServers) ? root.mcpServers[name] : undefined;
    if (!isRecord(entry) || entry.yoplaiManaged !== true || "displayName" in entry || "description" in entry) return;
    if (label.title) entry.displayName = label.title;
    if (label.description) entry.description = label.description;
    writeRawConfig(filePath, root);
  } catch { /* label is best-effort */ }
}

function extensionHub(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/edit`;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  createTools() {
    return [];
  },
});

/** Same URL ignoring host case, default port and trailing slash. */
function sameServerUrl(a: string, b: URL): boolean {
  const normalize = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  try { return normalize(new URL(a)) === normalize(b); } catch { return false; }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

type McpRuntimeConfig = { agents?: Array<{ id: string }>; oauth?: { providers?: Record<string, { clientId?: string; clientSecret?: string }> }; extensions?: Record<string, unknown>; env?: Record<string, string>; server?: { baseUrl?: string } };
export interface CredentialConnectHost {
  registerOAuthConnector(extensionId: string, start: (options: { agentId: string; userId: string; actorEmail?: string; impersonatorUserId?: string; targetId: string; onComplete: (targetId: string) => Promise<void> }) => Promise<string>): () => void;
  requestLink(toolContext: unknown, target: { kind: "extension-oauth"; extensionId: string; targetId: string }): Promise<string | undefined>;
}
type AuditEntry = AuditActor & { action: string; agentId: string; targetType: string; targetId: string; scope: "team" | "personal"; changes: { field: string; secret: "set" | "removed" }[] };
export type McpRuntime = { audit?: { record(entry: AuditEntry): void }; credentialConnect?: CredentialConnectHost; credentials?: ScopedCredentials; getDataDir(): string; getConfig(): McpRuntimeConfig; getAgent(id: string): AgentLike | undefined };

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
  const oauthProbeResults = new Map<string, { result: boolean; until: number }>();
  const oauthProbes = new Map<string, Promise<boolean>>();
  let runtime: McpRuntime | undefined;
  let oauth: McpOAuthStore | undefined;
  let connect: CredentialConnectHost | undefined;
  let resolveIcon: ReturnType<typeof createIconResolver> | undefined;
  let unregister: (() => void) | undefined;

  function catalogPath(): string { return path.join(runtime?.getDataDir() ?? "", "mcp.json"); }

  /** Shared catalog entries (HTTP only); an unreadable catalog is treated as empty. */
  function catalogServers(): Record<string, Record<string, unknown>> {
    try {
      const servers = readRawConfig(catalogPath()).mcpServers as Record<string, unknown>;
      return Object.fromEntries(Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]) && typeof entry[1].url === "string"));
    } catch { return {}; }
  }

  /**
   * Agent mcp.json servers plus catalog servers. A local entry with the same key or URL hides the catalog one.
   * `loaded` holds what actually runs: local servers and catalog servers the agent enabled via `sharedServers`.
   */
  function mergedForAgent(agent: AgentLike, root: { extensions?: Record<string, unknown>; env?: Record<string, string> }) {
    const resolved = resolveExtensionConfig(agent, root);
    const configPath = resolveConfigPath(agent, resolved);
    const localText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
    const catalog = !runtime || configPath === catalogPath() ? {} : catalogServers();
    if (localText === undefined && !Object.keys(catalog).length) return undefined;
    const local = localText === undefined ? { mcpServers: {} } : readRawConfig(configPath);
    const localServers = Object.values(local.mcpServers as Record<string, unknown>);
    const visible = Object.fromEntries(Object.entries(catalog).filter(([key, entry]) => {
      if (Object.hasOwn(local.mcpServers as object, key)) return false;
      try { const url = new URL(entry.url as string); return !localServers.some((item) => isRecord(item) && typeof item.url === "string" && sameServerUrl(item.url, url)); }
      catch { return false; }
    }));
    const enabled = new Set(Array.isArray(local.sharedServers) ? local.sharedServers.filter((item): item is string => typeof item === "string") : []);
    const all = parseMcpConfig(JSON.stringify({ mcpServers: { ...(local.mcpServers as object), ...visible } }), resolveInterpolationEnv(agent, root, resolved));
    const shared = new Set(Object.keys(visible));
    const loaded: LoadedMcpConfig = { servers: all.servers.filter((server) => !shared.has(server.name) || enabled.has(server.name)), errors: all.errors };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([localText ?? "", Object.entries(visible).filter(([key]) => enabled.has(key))])).digest("hex");
    return { configPath, all, loaded, shared, enabled, fingerprint };
  }

  function loadedForAgent(agentId: string): LoadedMcpConfig | undefined {
    const agent = runtime?.getAgent(agentId);
    return agent && runtime ? mergedForAgent(agent, runtime.getConfig())?.loaded : undefined;
  }

  function configForAgent(agentId: string): { agent: AgentLike; path: string } | undefined {
    const agent = runtime?.getAgent(agentId);
    if (!agent || !runtime) return undefined;
    return { agent, path: resolveConfigPath(agent, resolveExtensionConfig(agent, runtime.getConfig())) };
  }

  async function serverCard(agentId: string, server: McpServerConfig, requesterUserId?: string, shared?: { enabled: boolean }) {
    const active = !shared || shared.enabled;
    const oauthServer = active && server.type === "http" && !server.headers && await isOAuthServer(agentId, server);
    const auth = server.type === "stdio" ? "stdio" : server.headers ? "static" : oauthServer ? "oauth" : "none";
    const personal = oauthServer && requesterUserId ? await oauth?.read(agentId, server.name, { type: "personal", userId: requesterUserId }) : undefined;
    const team = oauthServer ? await oauth?.read(agentId, server.name, { type: "team" }) : undefined;
    const accountOf = (connection: typeof personal, scope: CredentialScope) => connection && server.type === "http" ? oauth?.backfillAccount(agentId, server.name, server.url, scope, connection) : undefined;
    const [personalAccount, teamAccount] = await Promise.all([accountOf(personal, { type: "personal", userId: requesterUserId ?? "" }), accountOf(team, { type: "team" })]);
    const scopeState = (connection: typeof personal) => connection?.state === "needs_reconnect" ? "needs_reconnect" : connection ? "connected" : "disconnected";
    const config = configForAgent(agentId);
    const rawPath = shared ? catalogPath() : config?.path;
    const raw = rawPath && fs.existsSync(rawPath) ? readRawConfig(rawPath) : undefined;
    const rawServer = isRecord(raw?.mcpServers) ? raw.mcpServers[server.name] : undefined;
    const managed = !shared && isRecord(rawServer) && rawServer.yoplaiManaged === true;
    let connected = false;
    let iconUrl: string | undefined;
    const rawText = (field: string) => isRecord(rawServer) && typeof rawServer[field] === "string" && rawServer[field].trim() ? rawServer[field].trim() : undefined;
    // Optional yoplai-only fields on any server entry (stdio too); MCP clients ignore unknown keys.
    const known = server.type === "http" ? knownServer(server.url) : undefined;
    let title = rawText("displayName") ?? known?.title;
    let description = rawText("description");
    const siteIcon = server.type === "http" ? resolveIcon?.(server.url) : undefined;
    const key = `${agentId}:status:${server.name}:${requesterUserId ?? "anonymous"}:${crypto.randomUUID()}`;
    if (active) try {
      const manager = await getManager(key, agentId, [server], requesterUserId);
      const tools = await manager.listTools();
      connected = manager.hasClient(server.name) && tools.some((tool) => tool.server === server.name);
      if (known && !rawText("displayName") && managed && config) saveLabel(config.path, server.name, { title });
      if (!title && !description && connected) {
        ({ title, description } = manager.getServerInfo(server.name));
        if ((title || description) && managed && config) saveLabel(config.path, server.name, { title, description });
      }
      const icon = manager.getServerIcon(server.name);
      if (icon) {
        try {
          const candidate = new URL(icon, server.type === "http" ? server.url : undefined);
          if (candidate.protocol === "http:" || candidate.protocol === "https:") iconUrl = candidate.toString();
        } catch { /* Ignore invalid server-provided icons. */ }
      }
    } finally {
      const manager = await managers.get(key);
      managers.delete(key);
      if (manager) void manager.close().catch(() => {});
    }
    return {
      name: server.name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      type: server.type,
      ...(server.type === "http" ? { url: server.url, iconUrl: iconUrl ?? await siteIcon } : iconUrl ? { iconUrl } : {}),
      auth,
      state: connected ? "connected" : personal?.state === "needs_reconnect" || team?.state === "needs_reconnect" ? "needs_reconnect" : "disconnected",
      ...(oauthServer ? { personalState: scopeState(personal), teamState: scopeState(team), ...(personalAccount ? { personalAccount } : {}), ...(teamAccount ? { teamAccount } : {}) } : {}),
      readOnly: !managed,
      ...(shared ? { shared: true, enabled: shared.enabled } : {}),
      ...(!shared && (rawText("displayName") || rawText("description")) ? { manualLabel: { displayName: rawText("displayName"), description: rawText("description") } } : {}),
    };
  }

  async function connectResponse(server: string, execution: unknown, response: unknown): Promise<unknown> {
    if (!execution || !isRecord(response) || response.connected !== false || response.provider !== "mcp") return response;
    const link = await connect?.requestLink(execution, { kind: "extension-oauth", extensionId: "mcp", targetId: server });
    return link ? { ...response, message: `Connect ${server} for just you: ${link}`, authorizeUrl: link } : response;
  }

  function html(server: string, success: boolean, message: string): string {
    const title = success ? "Connected" : "Connection failed";
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa}
.card{max-width:420px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12);text-align:center}
h1{color:${success ? "#137333" : "#c5221f"};font-size:20px;margin:0 0 12px}p{color:#3c4043;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p>
<p style="margin-top:16px;color:#5f6368;font-size:13px">You can close this window and return to Yoplai.</p></div><script>window.opener?.postMessage({type:"yoplai-oauth",extension:"mcp",server:${JSON.stringify(server)},success:${success}},"*")</script>`;
  }

  async function isOAuthServer(agent: string, server: Extract<McpServerConfig, { type: "http" }>): Promise<boolean> {
    const key = `${agent}:${server.name}`;
    if (server.oauth) return true;
    if (oauthServers.has(key) || await oauth?.read(agent, server.name)) return true;
    const probeKey = `${key}:${server.url}`;
    const cached = oauthProbeResults.get(probeKey);
    if (cached && cached.until > Date.now()) return cached.result;
    const active = oauthProbes.get(probeKey);
    if (active) return active;
    const probe = (async () => {
      let result = false;
      try {
        const response = await withTimeout(fetch(server.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ jsonrpc: "2.0", id: "oauth-detection", method: "initialize", params: {} }),
        }), 10_000, "MCP OAuth detection timed out");
        result = response.status === 401 || await hasProtectedResourceAuthServers(server.url);
        if (result) oauthServers.add(key);
      } catch {
        // Connection failures are not evidence that this server uses OAuth.
      }
      oauthProbeResults.set(probeKey, { result, until: Date.now() + 30_000 });
      return result;
    })();
    oauthProbes.set(probeKey, probe);
    try { return await probe; }
    finally { oauthProbes.delete(probeKey); }
  }

  async function resetManagers(agent?: string): Promise<void> {
    const keys = [...managers.keys()].filter((key) => !agent || key.startsWith(`${agent}:`));
    for (const key of keys) {
      const pending = managers.get(key);
      managers.delete(key);
      if (pending) void pending.then((manager) => manager.close()).catch(() => {});
    }
  }

  async function getManager(
    key: string,
    agentId: string,
    servers: LoadedMcpConfig["servers"],
    requesterUserId?: string
  ): Promise<McpClientManager> {
    const cached = managers.get(key);
    if (cached) {
      const manager = await cached;
      await manager.connect();
      return manager;
    }
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
        (server) => ({ connected: false, provider: "mcp", server, reason: "needs_reconnect", message: `${server} is not connected. Connect it from the agent's extensions.`, authorizeUrl: extensionHub(agentId) }),
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
    oauth = new McpOAuthStore(ctx.getDataDir(), resolveOAuthRedirectUri(ctx.getConfig()), ctx.credentials, (agentId, name) => {
      let server: McpServerConfig | undefined;
      try { server = loadedForAgent(agentId)?.servers.find((item) => item.name === name); } catch { return undefined; }
      return server?.type === "http" ? { url: server.url, clientId: server.oauth?.clientId } : undefined;
    }, () => ctx.getConfig().oauth?.providers);
    connect = ctx.credentialConnect;
    resolveIcon = createIconResolver(ctx.getDataDir());
    unregister = connect?.registerOAuthConnector("mcp", async ({ agentId, userId, actorEmail, impersonatorUserId, targetId, onComplete }) => {
      const server = loadedForAgent(agentId)?.servers.find((item) => item.name === targetId);
      if (!server || server.type !== "http" || server.headers || !oauth) throw new Error("Unknown OAuth MCP server");
      return (await oauth.begin(agentId, server.name, server.url, server.oauth, { type: "personal", userId }, onComplete, { actorUserId: userId, actorEmail, impersonatorUserId })).authorizationUrl;
    });
  },
  registerRoutes(app: RouteApp) {
    function actor(c: RouteContext): AuditActor {
      const auth = c.get?.("multiUserAuthContext");
      if (!isRecord(auth)) return {};
      const user = isRecord(auth.user) ? auth.user : {};
      const impersonator = isRecord(auth.impersonator) ? auth.impersonator : {};
      return {
        actorUserId: typeof user.id === "string" ? user.id : undefined,
        actorEmail: typeof user.email === "string" ? user.email : undefined,
        impersonatorUserId: typeof impersonator.id === "string" ? impersonator.id : undefined,
      };
    }
    function audit(entry: AuditEntry): void {
      try { runtime?.audit?.record(entry); }
      catch { console.warn("[mcp] Failed to record settings audit"); }
    }
    function multiUserEnabled(): boolean {
      const config = runtime?.getConfig().extensions?.multiUser;
      return isRecord(config) && config.enabled === true;
    }
    function userId(c: RouteContext): string | undefined {
      const auth = c.get?.("multiUserAuthContext");
      return isRecord(auth) && isRecord(auth.user) && typeof auth.user.id === "string" ? auth.user.id : undefined;
    }
    /** Whole-team MCP setup (shared mcp.json, team OAuth grants) is admin-only. */
    function canConfigureTeam(c: RouteContext): boolean {
      if (!multiUserEnabled()) return true;
      const auth = c.get?.("multiUserAuthContext");
      const role = isRecord(auth) && isRecord(auth.user) ? auth.user.role : undefined;
      const roles = Array.isArray(role) ? role : [role];
      return roles.some((value) => value === "admin" || value === "superadmin");
    }
    function isSuperadmin(c: RouteContext): boolean {
      if (!multiUserEnabled()) return true;
      const auth = c.get?.("multiUserAuthContext");
      const role = isRecord(auth) && isRecord(auth.user) ? auth.user.role : undefined;
      return (Array.isArray(role) ? role : [role]).includes("superadmin");
    }
    const capText = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : undefined;
    /** Sets or clears (empty) only the yoplai label fields present in `input`. */
    function applyLabel(entry: Record<string, unknown>, input: Record<string, unknown>): void {
      for (const [field, max] of [["displayName", 100], ["description", 500]] as const) {
        if (!(field in input)) continue;
        const value = capText(input[field], max);
        if (value) entry[field] = value; else delete entry[field];
      }
    }
    function catalogCard(name: string, entry: Record<string, unknown>) {
      return { name, url: entry.url as string, ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}), ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
    }
    /** Catalog routes are superadmin-only; returns an error response or undefined when allowed. */
    function catalogDenied(c: RouteContext) {
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      return isSuperadmin(c) ? undefined : c.text("Superadmin access required", 403);
    }
    function requestedScope(c: RouteContext): CredentialScope | undefined {
      const id = userId(c);
      if (c.req.query("scope") === "team" && (id || !multiUserEnabled())) return { type: "team" };
      if (!id) return undefined;
      if (c.req.query("scope") === "personal") return { type: "personal", userId: id };
      return undefined;
    }
    /** A usable personal grant shared from another agent needs no new authorization. */
    async function hasUsablePersonalGrant(agentId: string, name: string, scope: CredentialScope, url: string): Promise<boolean> {
      const grant = scope.type === "personal" ? await oauth?.read(agentId, name, scope, { url }) : undefined;
      return !!grant && grant.state !== "needs_reconnect";
    }
    app.get("/mcp/servers/personal-status", async (c) => {
      const agentId = c.req.query("agent");
      if (!agentId || !configForAgent(agentId)) return c.text("Unknown agent", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      let url: URL;
      try { url = new URL(c.req.query("url") ?? ""); }
      catch { return c.text("Invalid MCP server URL", 400); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return c.text("MCP server URL must be HTTP or HTTPS without embedded credentials", 400);
      const id = userId(c);
      return c.json({ connected: id ? await hasUsablePersonalGrant(agentId, siteLabel(url.hostname), { type: "personal", userId: id }, url.toString()) : false });
    });
    app.get("/mcp/servers", async (c) => {
      const agentId = c.req.query("agent");
      if (!agentId || !configForAgent(agentId)) return c.text("Unknown agent", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      const agent = runtime?.getAgent(agentId);
      const merged = agent && runtime ? mergedForAgent(agent, runtime.getConfig()) : undefined;
      const servers = merged ? await Promise.all(merged.all.servers.map((server) => serverCard(agentId, server, userId(c), merged.shared.has(server.name) ? { enabled: merged.enabled.has(server.name) } : undefined))) : [];
      return c.json({ servers, canConfigureTeam: canConfigureTeam(c), canEditLabels: isSuperadmin(c) });
    });
    app.post("/mcp/servers", async (c) => {
      const agentId = c.req.query("agent");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !config) return c.text("Unknown agent", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!isRecord(input) || typeof input.url !== "string" || (input.credentialScope !== "personal" && input.credentialScope !== "team")) return c.text("URL and credentialScope are required", 400);
      if (input.credentialScope === "team" && !canConfigureTeam(c)) return c.text("Team connections are unavailable", 403);
      let url: URL;
      try { url = new URL(input.url); }
      catch { return c.text("Invalid MCP server URL", 400); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return c.text("MCP server URL must be HTTP or HTTPS without embedded credentials", 400);
      const existing = readRawConfig(config.path).mcpServers;
      if (isRecord(existing) && Object.values(existing).some((entry) => isRecord(entry) && typeof entry.url === "string" && sameServerUrl(entry.url, url))) return c.text("This MCP server has already been added.", 409);
      const catalog = catalogServers();
      const taken = (candidate: string) => (isRecord(existing) && Object.hasOwn(existing, candidate)) || Object.hasOwn(catalog, candidate);
      const base = siteLabel(url.hostname);
      let name = base;
      for (let n = 2; taken(name); n++) name = `${base}_${n}`;
      const server: McpServerConfig = { type: "http", name, url: url.toString() };
      const scope: CredentialScope = input.credentialScope === "team" ? { type: "team" } : userId(c) ? { type: "personal", userId: userId(c)! } : { type: "team" };
      if (input.credentialScope === "personal" && scope.type !== "personal") return c.text("Authentication required for personal connection", 401);
      let flow: { state: string; authorizationUrl: string } | undefined;
      try {
        if (!await hasUsablePersonalGrant(agentId, name, scope, server.url) && await isOAuthServer(agentId, server)) {
          if (!oauth) throw new Error("OAuth is unavailable");
          const store = oauth;
          let timedOut = false;
          const pending = store.begin(agentId, name, server.url, undefined, scope, undefined, actor(c));
          void pending.then((late) => { if (timedOut) store.cancel(late.state); }).catch(() => {});
          try {
            flow = await withTimeout(pending, 30_000, "MCP OAuth authorization timed out");
          } catch (error) {
            timedOut = true;
            throw error;
          }
        }
        const root = readRawConfig(config.path);
        const servers = root.mcpServers as Record<string, unknown>;
        if (Object.hasOwn(servers, name)) throw new Error("MCP server name collision; retry adding the server");
        servers[name] = { url: server.url, yoplaiManaged: true };
        writeRawConfig(config.path, root);
        await resetManagers(agentId);
        audit({ ...actor(c), action: "mcp.server.add", agentId, targetType: "mcp", targetId: name, scope: scope.type, changes: [{ field: "mcpServers", secret: "set" }] });
        return c.json({ server: await serverCard(agentId, server, userId(c)), ...(flow ? { authorizationUrl: flow.authorizationUrl } : {}) });
      } catch (error) {
        if (flow) oauth?.cancel(flow.state);
        return c.text(error instanceof Error ? error.message : "Unable to add MCP server", 400);
      }
    });
    app.get("/mcp/catalog", async (c) => {
      const denied = catalogDenied(c);
      if (denied) return denied;
      const servers = await Promise.all(Object.entries(catalogServers()).map(async ([name, entry]) => ({ ...catalogCard(name, entry), iconUrl: await resolveIcon?.(entry.url as string) })));
      return c.json({ servers });
    });
    app.post("/mcp/catalog", async (c) => {
      const denied = catalogDenied(c);
      if (denied) return denied;
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!isRecord(input) || typeof input.url !== "string") return c.text("URL is required", 400);
      for (const field of ["command", "args", "env"]) if (field in input) return c.text(`"${field}" is not allowed; only HTTP servers can be shared`, 400);
      let url: URL;
      try { url = new URL(input.url); }
      catch { return c.text("Invalid MCP server URL", 400); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return c.text("MCP server URL must be HTTP or HTTPS without embedded credentials", 400);
      try {
        const root = readRawConfig(catalogPath());
        const servers = root.mcpServers as Record<string, unknown>;
        if (Object.values(servers).some((entry) => isRecord(entry) && typeof entry.url === "string" && sameServerUrl(entry.url, url))) return c.text("This MCP server is already in the catalog.", 409);
        const base = siteLabel(url.hostname);
        let name = base;
        for (let n = 2; Object.hasOwn(servers, name); n++) name = `${base}_${n}`;
        const entry: Record<string, unknown> = { url: url.toString() };
        applyLabel(entry, input);
        servers[name] = entry;
        fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
        writeRawConfig(catalogPath(), root);
        await resetManagers();
        audit({ ...actor(c), action: "mcp.server.add", agentId: "*", targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "catalog", secret: "set" }] });
        return c.json({ server: { ...catalogCard(name, entry), iconUrl: await resolveIcon?.(entry.url as string) } });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to add catalog server", 400);
      }
    });
    app.post("/mcp/catalog/update", async (c) => {
      const denied = catalogDenied(c);
      if (denied) return denied;
      const name = c.req.query("server");
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!name || !isRecord(input)) return c.text("Server and label are required", 400);
      try {
        const root = readRawConfig(catalogPath());
        const entry = (root.mcpServers as Record<string, unknown>)[name];
        if (!Object.hasOwn(root.mcpServers as object, name) || !isRecord(entry)) return c.text("Unknown catalog server", 404);
        applyLabel(entry, input);
        writeRawConfig(catalogPath(), root);
        audit({ ...actor(c), action: "mcp.server.update", agentId: "*", targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "catalog", secret: "set" }] });
        return c.json({ server: catalogCard(name, entry) });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to update catalog server", 400);
      }
    });
    app.post("/mcp/catalog/remove", async (c) => {
      const denied = catalogDenied(c);
      if (denied) return denied;
      const name = c.req.query("server");
      try {
        const root = readRawConfig(catalogPath());
        const servers = root.mcpServers as Record<string, unknown>;
        if (!name || !Object.hasOwn(servers, name)) return c.text("Unknown catalog server", 404);
        delete servers[name];
        writeRawConfig(catalogPath(), root);
        // A later server reusing this key must be opted in afresh.
        for (const { id } of runtime?.getConfig().agents ?? []) {
          const config = configForAgent(id);
          if (!config || !fs.existsSync(config.path)) continue;
          const agentRoot = readRawConfig(config.path);
          if (!Array.isArray(agentRoot.sharedServers) || !agentRoot.sharedServers.includes(name)) continue;
          agentRoot.sharedServers = agentRoot.sharedServers.filter((item) => item !== name);
          writeRawConfig(config.path, agentRoot);
        }
        await resetManagers();
        audit({ ...actor(c), action: "mcp.server.remove", agentId: "*", targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "catalog", secret: "removed" }] });
        return c.json({ ok: true });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to remove catalog server", 400);
      }
    });
    app.post("/mcp/servers/shared", async (c) => {
      const agentId = c.req.query("agent");
      const name = c.req.query("server");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !name || !config) return c.text("Unknown agent or server", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!isRecord(input) || typeof input.enabled !== "boolean") return c.text("enabled is required", 400);
      try {
        const merged = mergedForAgent(config.agent, runtime!.getConfig());
        const server = merged?.all.servers.find((item) => item.name === name);
        if (!merged || !server || !merged.shared.has(name)) return c.text("Unknown shared MCP server", 404);
        const root = readRawConfig(config.path);
        const list = (Array.isArray(root.sharedServers) ? root.sharedServers : []).filter((item) => item !== name);
        if (input.enabled) list.push(name);
        root.sharedServers = list;
        fs.mkdirSync(path.dirname(config.path), { recursive: true });
        writeRawConfig(config.path, root);
        await resetManagers(agentId);
        audit({ ...actor(c), action: input.enabled ? "mcp.server.enable" : "mcp.server.disable", agentId, targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "sharedServers", secret: input.enabled ? "set" : "removed" }] });
        return c.json({ server: await serverCard(agentId, server, userId(c), { enabled: input.enabled }) });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to update shared MCP server", 400);
      }
    });
    app.post("/mcp/servers/label", async (c) => {
      const agentId = c.req.query("agent");
      const name = c.req.query("server");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !name || !config) return c.text("Unknown agent or server", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      if (!isSuperadmin(c)) return c.text("Superadmin access required", 403);
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!isRecord(input)) return c.text("displayName or description is required", 400);
      try {
        const root = readRawConfig(config.path);
        const servers = root.mcpServers as Record<string, unknown>;
        const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
        if (!isRecord(entry)) return c.text("Unknown MCP server", 404);
        applyLabel(entry, input);
        writeRawConfig(config.path, root);
        audit({ ...actor(c), action: "mcp.server.update", agentId, targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "label", secret: "set" }] });
        return c.json({ ok: true });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to save MCP server label", 400);
      }
    });
    app.post("/mcp/servers/remove", async (c) => {
      const agentId = c.req.query("agent");
      const name = c.req.query("server");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !name || !config) return c.text("Unknown agent or server", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      if (!canConfigureTeam(c)) return c.text("Team configuration is unavailable", 403);
      try {
        const root = readRawConfig(config.path);
        const servers = root.mcpServers as Record<string, unknown>;
        if (!Object.hasOwn(servers, name)) return c.text("Unknown MCP server", 404);
        delete servers[name];
        writeRawConfig(config.path, root);
        await resetManagers(agentId);
        audit({ ...actor(c), action: "mcp.server.remove", agentId, targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "mcpServers", secret: "removed" }] });
        return c.json({ ok: true });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to remove MCP server", 400);
      }
    });
    app.get("/mcp/servers/config", async (c) => {
      const agentId = c.req.query("agent");
      const name = c.req.query("server");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !name || !config) return c.text("Unknown agent or server", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      try {
        const rawServer = readRawConfig(config.path).mcpServers as Record<string, unknown>;
        const server = Object.hasOwn(rawServer, name) ? rawServer[name] : undefined;
        if (!isRecord(server)) return c.text("Unknown MCP server", 404);
        const type = typeof server.command === "string" && typeof server.url !== "string" ? "stdio" : "http";
        return c.json({ name, type, editable: type === "http" && canConfigureTeam(c), config: maskServerConfig(server) });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to read MCP server config", 400);
      }
    });
    app.post("/mcp/servers/config", async (c) => {
      const agentId = c.req.query("agent");
      const name = c.req.query("server");
      const config = agentId ? configForAgent(agentId) : undefined;
      if (!agentId || !name || !config) return c.text("Unknown agent or server", 404);
      if (multiUserEnabled() && !userId(c)) return c.text("Authentication required", 401);
      if (!canConfigureTeam(c)) return c.text("Team configuration is unavailable", 403);
      let input: unknown;
      try { input = await c.req.json?.(); }
      catch { return c.text("Invalid JSON body", 400); }
      if (!isRecord(input) || !("config" in input)) return c.text("config is required", 400);
      try {
        const root = readRawConfig(config.path);
        const servers = root.mcpServers as Record<string, unknown>;
        const original = Object.hasOwn(servers, name) ? servers[name] : undefined;
        if (!isRecord(original)) return c.text("Unknown MCP server", 404);
        if (typeof original.command === "string" && typeof original.url !== "string") return c.text("stdio MCP servers are read-only", 403);
        const next = validateEditedHttpServer(input.config, original);
        servers[name] = next;
        writeRawConfig(config.path, root);
        await resetManagers(agentId);
        audit({ ...actor(c), action: "mcp.server.update", agentId, targetType: "mcp", targetId: name, scope: "team", changes: [{ field: "mcpServers", secret: "set" }] });
        return c.json({ name, type: "http", editable: true, config: maskServerConfig(next) });
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Unable to save MCP server config", 400);
      }
    });
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
        const account = connection ? await store.backfillAccount(agent, server.name, server.url, scope, connection) : undefined;
        return { name: server.name, url: server.url, auth: "oauth", state: connection?.state === "needs_reconnect" ? "needs_reconnect" : connection ? "connected" : "disconnected", ...(connection ? { connectedAt: connection.connectedAt, expiresAt: connection.expiresAt, ...(account ? { account } : {}) } : {}) };
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
      if (scope.type === "team" && !canConfigureTeam(c)) return c.text("Team connections are unavailable", 403);
      try { return c.redirect((await oauth.begin(agent, server.name, server.url, server.oauth, scope, undefined, actor(c))).authorizationUrl); }
      catch (error) { return c.text(error instanceof Error ? error.message : String(error), 400); }
    });
    app.get("/mcp/oauth/callback", async (c) => {
      const code = c.req.query("code"); const state = c.req.query("state");
      if (!code || !state || !oauth || c.req.query("error")) {
        if (state) oauth?.cancel(state);
        return c.html(html("", false, "OAuth connection failed"), 400);
      }
      try { const flow = await oauth.finish(state, code, (connected) => audit({ ...(connected.actor ?? actor(c)), action: "mcp.connect", agentId: connected.agent, targetType: "mcp", targetId: connected.server, scope: connected.scope.type, changes: [{ field: "credentials", secret: "set" }] })); oauthServers.add(`${flow.agent}:${flow.server}`); await resetManagers(flow.agent); return c.html(html(flow.server, true, "MCP server connected")); }
      catch (error) { return c.html(html("", false, error instanceof Error ? error.message : "OAuth connection failed"), 400); }
    });
    app.post("/mcp/oauth/disconnect", async (c) => {
      const scope = requestedScope(c);
      if (!scope) return c.text("Authenticated credential scope required", 400);
      if (scope.type === "team" && !canConfigureTeam(c)) return c.text("Team connections are unavailable", 403);
      const agent = c.req.query("agent"); const name = c.req.query("server");
      if (!agent || !name || !oauth) return c.json({ ok: true });
      if (await oauth.disconnect(agent, name, scope)) {
        audit({ ...actor(c), action: "mcp.disconnect", agentId: agent, targetType: "mcp", targetId: name, scope: scope.type, changes: [{ field: "credentials", secret: "removed" }] });
      }
      oauthServers.add(`${agent}:${name}`);
      await resetManagers(agent);
      return c.json({ ok: true });
    });
  },
  getSystemPromptContributions(agent: AgentLike, context?: { config: { extensions?: Record<string, unknown> } }) {
    if (!context) return undefined;
    try { return mergedForAgent(agent, context.config) ? [baseExtension.systemPrompt] : undefined; } catch { return [baseExtension.systemPrompt]; }
  },
  validateAgentConfigs(config: { agents: AgentLike[]; extensions?: Record<string, unknown> }) {
    const errors: string[] = [];
    for (const agent of config.agents) {
      try {
        McpExtensionConfigSchema.parse({
          ...resolveConfigRecord(config.extensions?.mcp),
          ...resolveConfigRecord(agent.extensions?.mcp),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { valid: errors.length === 0, errors };
  },
  async stop() {
    unregister?.();
    unregister = undefined;
    connect = undefined;
    oauthProbeResults.clear();
    oauthProbes.clear();
    oauthServers.clear();
    const resolvedManagers = await Promise.all([...managers.values()]);
    await Promise.all(resolvedManagers.map((manager) => manager.close()));
    managers.clear();
    await baseExtension.stop();
  },
  async getAgentTools(agent: AgentLike, context?: { userId?: string; config: { extensions?: Record<string, unknown>; env?: Record<string, string> } }) {
    if (!context) return [];
    const extensionConfig = resolveExtensionConfig(agent, context.config);
    const configPath = resolveConfigPath(agent, extensionConfig);
    const merged = mergedForAgent(agent, context.config);
    if (!merged) return [];
    const revision = merged.fingerprint;
    const loaded = merged.loaded;
    logConfigErrors(loaded);
    const manager = await getManager(`${agent.id}:${configPath}:${revision}:${context.userId ?? "anonymous"}`, agent.id, loaded.servers, context.userId);
    const definitions = await manager.listTools();
    const tools = adaptMcpTools(definitions, manager);
    const connectedTools = tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchemaParameters ?? {},
      execute: async (params: unknown, execution?: { userId?: string }) => {
        let now: string | undefined;
        try { now = mergedForAgent(agent, context.config)?.fingerprint; } catch { /* treated as changed */ }
        if (now !== revision) {
          return { connected: false, provider: "mcp", reason: "configuration_changed", message: "MCP server settings changed. Reload the agent's tools." };
        }
        const definition = definitions[index]!;
        const target = loaded.servers.find((server) => server.name === definition.server)!;
        if (target.type !== "http" || target.headers || !await isOAuthServer(agent.id, target)) return tool.execute(params);
        const requester = execution?.userId;
        const key = `${agent.id}:${configPath}:${requester ?? "anonymous"}:${crypto.randomUUID()}`;
        const fresh = await getManager(key, agent.id, [target], requester);
        try {
          const current = (await fresh.listTools()).find((entry) => entry.name === definition.name && entry.server === definition.server);
          if (current) return await connectResponse(target.name, execution, await fresh.invokeTool(current.server, current.name, params));
          return connectResponse(target.name, execution, { connected: false, provider: "mcp", reason: "not_connected", message: "Connect this MCP server from the agent's extensions.", authorizeUrl: extensionHub(agent.id) });
        } finally { managers.delete(key); await fresh.close(); }
      },
    }));
    const disconnected = await Promise.all(loaded.servers.filter((server): server is Extract<McpServerConfig, { type: "http" }> => server.type === "http" && !server.headers).map(async (server) => {
      if (!await isOAuthServer(agent.id, server) || await oauth?.accessToken(agent.id, server.name, 60_000, context.userId)) return undefined;
      return {
        name: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, "_")}__not_connected`,
        description: `Connect ${server.name} from the agent's extensions before using its tools.`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_params: unknown, execution?: { userId?: string }) => connectResponse(server.name, execution, { connected: false, provider: "mcp", server: server.name, reason: "not_connected", message: `${server.name} is not connected. Connect it from the agent's extensions.`, authorizeUrl: extensionHub(agent.id) }),
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
