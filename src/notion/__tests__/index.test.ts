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

    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_data_sources",
      "list_pages",
      "search_pages",
      "get_data_source",
      "update_data_source",
      "query_data_source",
      "get_page",
      "get_page_markdown",
      "create_page",
      "update_page_properties",
      "update_page_markdown",
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

  it("returns structured extraction errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ExpiredToken", { status: 403 }));
    const tool = createTools().find(({ name }) => name === "download_and_extract_file");

    await expect(tool?.execute({ url: "https://example.com/cv.pdf?signature=expired" })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "SIGNED_URL_EXPIRED", status: 403, retryable: false }),
    });
  });

});
