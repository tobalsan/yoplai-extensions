import { describe, expect, it } from "vitest";

import { McpClientManager } from "../client-manager.js";
import { adaptMcpTools, getMcpExtensionToolName } from "../tool-adapter.js";

describe("MCP tool adapter", () => {
  it("namespaces server and tool names and preserves JSON schema parameters", async () => {
    const manager = new McpClientManager(
      [{ type: "stdio", name: "github-main", command: "node" }],
      async () => ({
        async listTools() {
          return [];
        },
        async callTool(name, args) {
          return { name, args };
        },
        async close() {},
      })
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

    expect(getMcpExtensionToolName(tool)).toBe("github_main__search_issues");
    const adapted = adaptMcpTools([tool], manager);
    expect(adapted[0]?.jsonSchemaParameters).toEqual(tool.inputSchema);
    expect(adapted[0]?.parameters.parse({ q: "bug", extra: true })).toEqual({
      q: "bug",
      extra: true,
    });
    await expect(adapted[0]?.execute({ q: "bug" })).resolves.toEqual({
      name: "search/issues",
      args: { q: "bug" },
    });
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
      "github_main__search_issues",
      "github_main__search_issues__2",
    ]);
  });
});
