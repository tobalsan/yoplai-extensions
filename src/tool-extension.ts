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
    }
  | {
      connected: false;
      provider: string;
      reason: "not_connected" | "provider_not_configured" | "expired";
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

export interface ToolExtensionTool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  jsonSchemaParameters?: Record<string, unknown>;
  execute(params: unknown): Promise<unknown>;
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
  configRoute?: { path: string };
  /**
   * Declares that this extension needs an OAuth token. When set, `createTools`
   * receives `config.oauth` with a fresh access token (or a not-connected
   * signal) resolved by the host at tool-build time.
   */
  oauth?: OAuthRequirement;
  createTools(config: ResolvedToolExtensionConfig): ToolExtensionTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  for (const secretName of definition.requiredSecrets) {
    const value = resolved.merged[secretName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Extension "${definition.id}" for agent "${agent.id}" missing required secret "${secretName}"`
      );
    }
  }
  return resolved;
}

async function resolveOAuthForDefinition(
  definition: ToolExtensionDefinition,
  agent: { id: string },
  context: ToolExtensionHookContext
): Promise<ResolvedOAuth | undefined> {
  if (!definition.oauth) return undefined;
  if (!context.resolveOAuth) {
    return {
      connected: false,
      provider: definition.oauth.provider,
      reason: "provider_not_configured",
      message: `OAuth provider "${definition.oauth.provider}" is not configured on this host.`,
    };
  }
  return context.resolveOAuth(agent, definition.oauth, context.userId);
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

export function defineToolExtension(definition: ToolExtensionDefinition) {
  return {
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    requiredSecrets: definition.requiredSecrets,
    oauth: definition.oauth,
    advancedConfigFields: definition.advancedConfigFields,
    configJsonSchema: zodToJsonSchema(definition.configSchema, { $refStrategy: "none" }),
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
      resolved.oauth = await resolveOAuthForDefinition(definition, agent, context);
      return [
        definition.systemPrompt?.trim() || undefined,
        renderMountedToolNames(definition, resolved),
      ].filter((prompt): prompt is string => Boolean(prompt));
    },
    async getAgentTools(agent: { id: string; extensions?: Record<string, unknown> }, context?: ToolExtensionHookContext) {
      if (!context) return [];
      const resolved = resolveConfig(definition, context.config, agent);
      if (!resolved) return [];
      resolved.oauth = await resolveOAuthForDefinition(definition, agent, context);
      return definition.createTools(resolved).map((tool) => ({
        name: getMountedToolName(definition, tool.name),
        description: tool.description,
        parameters: expandTypeArrays(
          tool.jsonSchemaParameters ??
            zodToJsonSchema(tool.parameters, {
              $refStrategy: "none",
            })
        ) as Record<string, unknown>,
        execute: async (params: unknown, toolContext?: { userId?: string }) => {
          if (!definition.oauth || !context.resolveOAuth) return tool.execute(params);
          // Re-resolve per call so the token matches this call's requester.
          const oauth = await context.resolveOAuth(
            agent,
            definition.oauth,
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
          return callTimeTool.execute(params);
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
