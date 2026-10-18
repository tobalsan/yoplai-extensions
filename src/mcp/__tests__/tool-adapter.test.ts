import { describe, expect, it } from "vitest";

import { McpClientManager } from "../client-manager.js";
import { adaptMcpTools, getMcpExtensionToolName, normalizeTypeLists } from "../tool-adapter.js";

describe("MCP tool adapter", () => {
  it("namespaces server and tool names and preserves JSON schema parameters", async () => {
    const manager = new McpClientManager(
      [{ type: "stdio", name: "github-main", command: "node" }],
      {
        clientFactory: async () => ({
          async listTools() {
            return [];
          },
          async callTool(name, args) {
            return { content: [{ type: "text", text: name }], structuredContent: { args }, isError: true };
          },
          async close() {},
        }),
      }
    );
    await manager.connect();
    const tool = {
      server: "github-main",
      name: "search/issues",
      description: "Search issues",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    };

    expect(getMcpExtensionToolName(tool)).toBe("mcp__github_main__search_issues");
    const adapted = adaptMcpTools([tool], manager);
    expect(adapted[0]?.jsonSchemaParameters).toEqual(tool.inputSchema);
    expect(adapted[0]?.parameters.parse({ q: "bug", extra: true })).toEqual({
      q: "bug",
      extra: true,
    });
    const signal = new AbortController().signal;
    await expect(adapted[0]?.execute({ q: "bug" }, { signal })).resolves.toEqual({
      content: [{ type: "text", text: "search/issues" }],
      structuredContent: { args: { q: "bug" } },
      isError: true,
    });
    await manager.close();
  });

  it("suffixes sanitized name collisions", () => {
    const manager = new McpClientManager([]);
    const adapted = adaptMcpTools(
      [
        {
          server: "github-main",
          name: "search/issues",
          description: "Search issues",
          inputSchema: { type: "object" },
        },
        {
          server: "github_main",
          name: "search_issues",
          description: "Search issues again",
          inputSchema: { type: "object" },
        },
      ],
      manager
    );

    expect(adapted.map((tool) => tool.name)).toEqual([
      "mcp__github_main__search_issues",
      "mcp__github_main__search_issues__2",
    ]);
  });

  it("rewrites JSON Schema type lists as anyOf", () => {
    expect(
      normalizeTypeLists({
        type: "object",
        properties: {
          folder: { type: ["string", "null"], description: "d" },
          tags: { type: ["array"], items: { type: ["string", "null"] } },
        },
      })
    ).toEqual({
      type: "object",
      properties: {
        folder: { anyOf: [{ type: "string" }, { type: "null" }], description: "d" },
        tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
    });
  });
});
