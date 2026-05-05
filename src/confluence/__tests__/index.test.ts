import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { ConfluenceConfigSchema } from "../models.js";

describe("confluence extension", () => {
  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("confluence");
    expect(extension.displayName).toBe("Confluence");
    expect(extension.description).toContain("Confluence");
    expect(extension.requiredSecrets).toEqual(["email", "apiToken"]);
  });

  it("parses config defaults", () => {
    expect(
      ConfluenceConfigSchema.parse({
        subdomain: "mycompany",
        email: "user@example.com",
        apiToken: "token",
      }),
    ).toEqual({
      subdomain: "mycompany",
      email: "user@example.com",
      apiToken: "token",
      timeoutMs: 30_000,
    });
  });

  it("creates the expected tools with object parameter schemas", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: {
        subdomain: "mycompany",
        email: "user@example.com",
        apiToken: "token",
        timeoutMs: 30_000,
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      "get_page",
      "get_page_children",
      "get_page_ancestors",
      "list_attachments",
      "download_and_extract_file",
      "list_labels",
      "get_pages_by_label",
      "list_spaces",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("omits list_spaces when confluenceSpace is set", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: {
        subdomain: "mycompany",
        email: "user@example.com",
        apiToken: "token",
        timeoutMs: 30_000,
        confluenceSpace: "ENG",
      },
    });

    expect(tools.map((tool) => tool.name)).not.toContain("list_spaces");
    expect(tools.map((tool) => tool.name)).toContain("validate");
  });
});
