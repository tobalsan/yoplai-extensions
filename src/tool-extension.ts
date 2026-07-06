import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ResolvedToolExtensionConfig {
  global: Record<string, unknown>;
  root?: Record<string, unknown>;
  agent: Record<string, unknown>;
  merged: Record<string, unknown>;
}

export interface ToolExtensionTool {
  name: string;
  description: string;
  parameters: z.AnyZodObject;
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
    "AIHub exposes this extension's tools with these exact names:",
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
    getSystemPromptContributions(agent: { id: string; extensions?: Record<string, unknown> }, context?: { config: { extensions?: Record<string, unknown> } }) {
      if (!context) return undefined;
      const resolved = resolveConfig(definition, context.config, agent);
      if (!resolved) return undefined;
      return [
        definition.systemPrompt?.trim() || undefined,
        renderMountedToolNames(definition, resolved),
      ].filter((prompt): prompt is string => Boolean(prompt));
    },
    getAgentTools(agent: { id: string; extensions?: Record<string, unknown> }, context?: { config: { extensions?: Record<string, unknown> } }) {
      if (!context) return [];
      const resolved = resolveConfig(definition, context.config, agent);
      if (!resolved) return [];
      return definition.createTools(resolved).map((tool) => ({
        name: getMountedToolName(definition, tool.name),
        description: tool.description,
        parameters:
          tool.jsonSchemaParameters ??
          zodToJsonSchema(tool.parameters, {
            $refStrategy: "none",
          }),
        execute: (params: unknown) => tool.execute(params),
      }));
    },
  };
}
