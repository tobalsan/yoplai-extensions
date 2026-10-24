import { z } from "zod";

import type { McpClientManager, McpToolDefinition } from "./client-manager.js";
import type { ToolExtensionTool } from "../tool-extension.js";

export const McpCallToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
}).passthrough();

export function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.replace(/^_+|_+$/g, "") || "tool";
}

export function getMcpExtensionToolName(tool: McpToolDefinition): string {
  return `mcp__${sanitizeSegment(tool.server)}__${sanitizeSegment(tool.name)}`;
}

// Some providers' tool-call parsers (e.g. opencode-go MiMo) break on
// `type: [...]` lists; `anyOf` is equivalent and broadly supported.
export function normalizeTypeLists(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeTypeLists);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = normalizeTypeLists(value);
  if (Array.isArray(out.type)) {
    const types = out.type as unknown[];
    delete out.type;
    if (types.length === 1) out.type = types[0];
    else out.anyOf = types.map((type) => ({ type }));
  }
  return out;
}

export function adaptMcpTools(
  tools: McpToolDefinition[],
  manager: McpClientManager
): (Omit<ToolExtensionTool, "execute"> & {
  execute(params: unknown, execution?: { agentId?: string; userId?: string; signal?: AbortSignal }): Promise<unknown>;
})[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const baseName = getMcpExtensionToolName(tool);
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    const name = count === 0 ? baseName : `${baseName}__${count + 1}`;
    return {
      name,
      mcp: { server: tool.server, tool: tool.name, ...(tool.ui ? { ui: tool.ui } : {}) },
      description: tool.description,
      parameters: z.object({}).passthrough(),
      outputSchema: McpCallToolResultSchema,
      jsonSchemaParameters: normalizeTypeLists(tool.inputSchema) as Record<string, unknown>,
      execute: async (params, execution) => manager.invokeTool(tool.server, tool.name, params, { signal: execution?.signal }),
    };
  });
}
