import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import connector from "../index.js";

describe("notion connector", () => {
  it("exports the expected connector contract", () => {
    expect(connector.id).toBe("notion");
    expect(connector.displayName).toBe("Notion");
    expect(connector.description).toContain("Notion");
    expect(connector.requiredSecrets).toEqual(["apiKey"]);
  });

  it("parses config defaults", () => {
    expect(
      connector.configSchema.parse({
        apiKey: "secret",
      }),
    ).toEqual({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 30_000,
    });
  });

  it("creates the expected tools with object parameter schemas", () => {
    const tools = connector.createTools({
      global: {},
      agent: {},
      merged: {
        apiKey: "secret",
      },
    });

    expect(tools).toHaveLength(11);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_data_sources",
      "get_data_source",
      "update_data_source",
      "query_data_source",
      "get_page",
      "update_page_properties",
      "get_blocks",
      "append_blocks",
      "delete_block",
      "download_and_extract_file",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});
