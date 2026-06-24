import { z } from "zod";

import type { McpClientManager, McpToolDefinition } from "./client-manager.js";
import type { ToolExtensionTool } from "../tool-extension.js";

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.replace(/^_+|_+$/g, "") || "tool";
}

export function getMcpExtensionToolName(tool: McpToolDefinition): string {
  return `${sanitizeSegment(tool.server)}__${sanitizeSegment(tool.name)}`;
}

export function adaptMcpTools(
  tools: McpToolDefinition[],
  manager: McpClientManager
): ToolExtensionTool[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const baseName = getMcpExtensionToolName(tool);
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    const name = count === 0 ? baseName : `${baseName}__${count + 1}`;
    return {
      name,
      description: tool.description,
      parameters: z.object({}).passthrough(),
      jsonSchemaParameters: tool.inputSchema,
      execute: async (params) => manager.invokeTool(tool.server, tool.name, params),
    };
  });
}
