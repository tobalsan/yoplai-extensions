import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * OAuth requirement declared by an extension. The host resolves it into a fresh
 * token at tool-build time (see `ResolvedToolExtensionConfig.oauth`).
 */
export interface OAuthRequirement {
  provider: string;
  scopes?: string[];
}

/**
 * OAuth provider descriptor shipped by an extension. The host registers it at
 * extension load; the OAuth flow, secrets and token store stay in the host.
 * URLs may contain a `{subdomain}` placeholder.
 */
export interface OAuthProviderDescriptor {
  /** Stable id used in routes and storage, e.g. "google". */
  id: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation endpoint, best-effort called on disconnect. */
  revokeUrl?: string;
  /** Endpoint fetched after token exchange to identify the connected account. */
  userInfoUrl?: string;
  defaultScopes: string[];
  /** Base URL of the provider's API, handed to extensions that need it. */
  apiBaseUrl?: string;
  /** Extra query params appended to the authorize URL. */
  authorizeParams?: Record<string, string>;
  /**
   * How client credentials reach the token (and revoke) endpoint: "body"
   * (default) or "basic" (HTTP Basic header, not in the body).
   */
  tokenAuth?: "body" | "basic";
  /**
   * Encoding of token exchange, refresh and revoke request bodies: "form"
   * (default, application/x-www-form-urlencoded) or "json" (application/json).
   */
  tokenRequestFormat?: "form" | "json";
  /** Extract a human-readable account label from a parsed userinfo response. */
  extractAccount?(userInfo: unknown): string | undefined;
  /** Extract the account label from the token response; preferred over `userInfoUrl`. */
  accountFromTokenResponse?(token: unknown): string | undefined;
}

/**
 * Structured OAuth resolution injected by the host: a fresh access token when
 * connected, or a clear not-connected signal — never a raw secret, never a
 * thrown 401.
 */
export type ResolvedOAuth =
  | {
      connected: true;
      provider: string;
      accessToken: string;
      account?: string;
      scopes: string[];
      expiresAt?: number;
      /** Provider API base URL, for providers with per-tenant hosts. */
      apiBaseUrl?: string;
    }
  | {
      connected: false;
      provider: string;
      reason: "not_connected" | "provider_not_configured" | "expired" | "needs_reconnect" | "insufficient_scope";
      authorizeUrl?: string;
      message: string;
    };

/** Host-injected hook context passed to the extension's tool/prompt hooks. */
export interface ToolExtensionHookContext {
  config: { extensions?: Record<string, unknown> };
  /** Requesting Yoplai user; selects their personal credential over the team one. */
  userId?: string;
  resolveOAuth?: (
    agent: { id: string },
    requirement: OAuthRequirement,
    requesterUserId?: string
  ) => Promise<ResolvedOAuth>;
}

export interface ResolvedToolExtensionConfig {
  global: Record<string, unknown>;
  root?: Record<string, unknown>;
  agent: Record<string, unknown>;
  merged: Record<string, unknown>;
  /** Present only when the extension declared an `oauth` requirement. */
  oauth?: ResolvedOAuth;
}

export interface ToolExecutionContext {
  agentId?: string;
  agent?: { id: string };
  sessionId?: string;
  userId?: string;
  signal?: AbortSignal;
  conversationFiles?: { hostPath: string; runtimePath: string };
}

export interface ToolExtensionTool {
  name: string;
  description: string;
  annotations?: { readOnlyHint?: boolean };
  parameters: z.ZodTypeAny;
  jsonSchemaParameters?: Record<string, unknown>;
  execute(params: unknown, context?: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExtensionDefinition {
  id: string;
  displayName: string;
  description: string;
  systemPrompt?: string;
  configSchema: z.ZodTypeAny;
  agentConfigSchema?: z.ZodTypeAny;
  requiredSecrets: string[];
  advancedConfigFields?: string[];
  /** Fields hidden from the config form when the agent uses OAuth (e.g. API-key credentials). */
  oauthHiddenFields?: string[];
  /** UI labels for config fields, emitted as JSON Schema `title`. */
  configFieldTitles?: Record<string, string>;
  configRoute?: { path: string };
  /**
   * Declares that this extension needs an OAuth token. When set, `createTools`
   * receives `config.oauth` with a fresh access token (or a not-connected
   * signal) resolved by the host at tool-build time.
   */
  oauth?: OAuthRequirement | ((config: ResolvedToolExtensionConfig) => OAuthRequirement | undefined);
  /** Static OAuth provider descriptors, registered by the host at load time. */
  oauthProviders?: OAuthProviderDescriptor[];
  createTools(config: ResolvedToolExtensionConfig): ToolExtensionTool[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stripEnabled(value: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = value;
  void _enabled;
  return rest;
}

export function resolveEnvRefs(value: unknown): unknown {
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

function resolveConfig(
  definition: ToolExtensionDefinition,
  config: { extensions?: Record<string, unknown> },
  agent: { id: string; extensions?: Record<string, unknown> }
): ResolvedToolExtensionConfig | undefined {
  const rawAgent = agent.extensions?.[definition.id];
  if (rawAgent === undefined) return undefined;
  const agentRecord = toRecord(rawAgent);
  if (agentRecord.enabled === false) return undefined;

  const root = resolveEnvRefs(
    stripEnabled(toRecord(config.extensions?.[definition.id]))
  ) as Record<string, unknown>;
  const agentConfig = resolveEnvRefs(stripEnabled(agentRecord)) as Record<
    string,
    unknown
  >;
  if (definition.agentConfigSchema) {
    definition.agentConfigSchema.parse(agentConfig);
  }
  const resolved = {
    global: root,
    root,
    agent: agentConfig,
    merged: { ...root, ...agentConfig },
  };
  definition.configSchema.parse(resolved.merged);
  // An OAuth-mode agent authenticates with a token, not with secrets.
  const usesOAuth = oauthRequirement(definition, resolved) !== undefined;
  for (const secretName of usesOAuth ? [] : definition.requiredSecrets) {
    const value = resolved.merged[secretName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Extension "${definition.id}" for agent "${agent.id}" missing required secret "${secretName}"`
      );
    }
  }
  return resolved;
}

function oauthRequirement(
  definition: ToolExtensionDefinition,
  resolved: ResolvedToolExtensionConfig
): OAuthRequirement | undefined {
  return typeof definition.oauth === "function" ? definition.oauth(resolved) : definition.oauth;
}

/** Standard "not connected" tool result; `fallbackMessage` applies when no host OAuth state is available. */
export function notConnected(provider: string, fallbackMessage: string, oauth?: ResolvedOAuth) {
  const disconnected = oauth && !oauth.connected ? oauth : undefined;
  return {
    connected: false,
    provider,
    reason: disconnected?.reason ?? "not_connected",
    message: disconnected?.message ?? fallbackMessage,
    authorizeUrl: disconnected && "authorizeUrl" in disconnected ? disconnected.authorizeUrl : undefined,
  };
}

async function resolveOAuthForDefinition(
  definition: ToolExtensionDefinition,
  agent: { id: string },
  context: ToolExtensionHookContext,
  resolved: ResolvedToolExtensionConfig
): Promise<ResolvedOAuth | undefined> {
  const requirement = oauthRequirement(definition, resolved);
  if (!requirement) return undefined;
  if (!context.resolveOAuth) {
    return {
      connected: false,
      provider: requirement.provider,
      reason: "provider_not_configured",
      message: `OAuth provider "${requirement.provider}" is not configured on this host.`,
    };
  }
  return context.resolveOAuth(agent, requirement, context.userId);
}

function getMountedToolName(
  definition: ToolExtensionDefinition,
  toolName: string
): string {
  return toolName.startsWith(`${definition.id}_`)
    ? toolName
    : `${definition.id}_${toolName}`;
}

function renderMountedToolNames(
  definition: ToolExtensionDefinition,
  resolved: ResolvedToolExtensionConfig
): string {
  return [
    "Yoplai exposes this extension's tools with these exact names:",
    ...definition
      .createTools(resolved)
      .map((tool) => `- ${getMountedToolName(definition, tool.name)}: ${tool.description}`),
  ].join("\n");
}

function withFieldTitles<T>(schema: T, titles: Record<string, string> = {}): T {
  const properties = (schema as { properties?: Record<string, object> }).properties;
  if (!properties) return schema;
  for (const [name, title] of Object.entries(titles)) {
    if (properties[name]) properties[name] = { ...properties[name], title };
  }
  return schema;
}

export function defineToolExtension(definition: ToolExtensionDefinition) {
  return {
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    requiredSecrets: definition.requiredSecrets,
    oauth: definition.oauth,
    oauthProviders: definition.oauthProviders,
    advancedConfigFields: definition.advancedConfigFields,
    oauthHiddenFields: definition.oauthHiddenFields,
    configJsonSchema: withFieldTitles(zodToJsonSchema(definition.configSchema, { $refStrategy: "none" }), definition.configFieldTitles),
    configRoute: definition.configRoute,
    createTools: definition.createTools,
    dependencies: [],
    configSchema: z.object({ enabled: z.boolean().optional() }).passthrough(),
    routePrefixes: [],
    validateConfig(raw: unknown) {
      const result = z.object({ enabled: z.boolean().optional() }).passthrough().safeParse(raw ?? {});
      return {
        valid: result.success,
        errors: result.success ? [] : result.error.issues.map((issue) => issue.message),
      };
    },
    validateAgentConfigs(config: { agents: Array<{ id: string; extensions?: Record<string, unknown> }>; extensions?: Record<string, unknown> }) {
      const errors: string[] = [];
      for (const agent of config.agents) {
        try {
          resolveConfig(definition, config, agent);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { valid: errors.length === 0, errors };
    },
    registerRoutes() {
      return undefined;
    },
    async start() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    capabilities() {
      return [];
    },
    async getSystemPromptContributions(agent: { id: string; extensions?: Record<string, unknown> }, context?: ToolExtensionHookContext) {
      if (!context) return undefined;
      const resolved = resolveConfig(definition, context.config, agent);
      if (!resolved) return undefined;
      resolved.oauth = await resolveOAuthForDefinition(definition, agent, context, resolved);
      return [
        definition.systemPrompt?.trim() || undefined,
        renderMountedToolNames(definition, resolved),
      ].filter((prompt): prompt is string => Boolean(prompt));
    },
    async getAgentTools(agent: { id: string; extensions?: Record<string, unknown> }, context?: ToolExtensionHookContext) {
      if (!context) return [];
      const resolved = resolveConfig(definition, context.config, agent);
      if (!resolved) return [];
      resolved.oauth = await resolveOAuthForDefinition(definition, agent, context, resolved);
      return definition.createTools(resolved).map((tool) => ({
        name: getMountedToolName(definition, tool.name),
        description: tool.description,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        parameters: expandTypeArrays(
          tool.jsonSchemaParameters ??
            zodToJsonSchema(tool.parameters, {
              $refStrategy: "none",
            })
        ) as Record<string, unknown>,
        execute: async (params: unknown, toolContext?: ToolExecutionContext) => {
          const executionContext = { ...toolContext, agentId: agent.id };
          if (!definition.oauth || !context.resolveOAuth) return tool.execute(params, executionContext);
          // Re-resolve per call so the token matches this call's requester.
          const requirement = oauthRequirement(definition, resolved);
          if (!requirement) return tool.execute(params, executionContext);
          const oauth = await context.resolveOAuth(
            agent,
            requirement,
            toolContext?.userId ?? context.userId
          );
          const callTimeTool = definition
            .createTools({ ...resolved, oauth })
            .find((candidate) => candidate.name === tool.name);
          if (!callTimeTool) {
            throw new Error(
              `OAuth tool "${getMountedToolName(definition, tool.name)}" is no longer available`
            );
          }
          return callTimeTool.execute(params, executionContext);
        },
      }));
    },
  };
}

/**
 * Rewrite `type: ["string", "number"]` (zod-to-json-schema's output for
 * primitive unions) into `anyOf`. Some providers' tool parsers (e.g.
 * opencode-go mimo) choke on type arrays: the call leaks as text XML and the
 * structured tool call arrives with empty/nested garbage arguments.
 */
export function expandTypeArrays(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(expandTypeArrays);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === "properties" || key === "definitions"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandTypeArrays(v)]))
      : expandTypeArrays(value);
  }
  if (Array.isArray(out.type)) {
    const types = out.type as unknown[];
    delete out.type;
    out.anyOf = types.map((type) => ({ type }));
  }
  return out;
}
