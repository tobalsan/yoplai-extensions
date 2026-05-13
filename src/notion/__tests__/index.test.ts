import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { NotionConfigSchema } from "../models.js";

describe("notion extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("notion");
    expect(extension.displayName).toBe("Notion");
    expect(extension.description).toContain("Notion");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
  });

  it("parses config defaults", () => {
    expect(
      NotionConfigSchema.parse({
        apiKey: "secret",
      }),
    ).toEqual({
      apiKey: "secret",
      notionVersion: "2026-03-11",
      timeoutMs: 30_000,
    });
  });

  function createTools() {
    return extension.createTools({
      global: {},
      agent: {},
      merged: {
        apiKey: "secret",
      },
    });
  }

  it("creates the expected tools with object parameter schemas", () => {
    const tools = createTools();

    expect(tools).toHaveLength(14);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_data_sources",
      "list_pages",
      "search_pages",
      "get_data_source",
      "update_data_source",
      "query_data_source",
      "get_page",
      "update_page_properties",
      "get_blocks",
      "append_blocks",
      "delete_block",
      "replace_child_blocks",
      "download_and_extract_file",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("saves oversized read tool responses to a file", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ object: "page", content: "x".repeat(210_000) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = createTools().find((candidate) => candidate.name === "list_pages");
    const result = (await tool?.execute({})) as Record<string, unknown>;

    expect(result).toMatchObject({
      object: "large_response_saved",
      tool: "notion_list_pages",
      bytes: expect.any(Number),
    });
    expect(typeof result.filePath).toBe("string");
    const saved = JSON.parse(await readFile(result.filePath as string, "utf8")) as Record<string, unknown>;
    expect(saved).toHaveProperty("results");
  });
});
