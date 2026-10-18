import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { ConfluenceConfigSchema } from "../models.js";

describe("confluence extension", () => {
  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("confluence");
    expect(extension.displayName).toBe("Confluence");
    expect(extension.description).toContain("Confluence");
    expect(extension.requiredSecrets).toEqual(["apiToken"]);
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
      "create_page",
      "replace_page",
      "get_page_children",
      "get_page_ancestors",
      "list_attachments",
      "download_and_extract_file",
      "list_labels",
      "get_pages_by_label",
      "list_space_pages",
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
    expect(tools.map((tool) => tool.name)).toContain("list_space_pages");
    expect(tools.map((tool) => tool.name)).toContain("validate");
    expect(tools.map((tool) => tool.name)).toContain("create_page");
    expect(tools.map((tool) => tool.name)).toContain("replace_page");
  });

  it("keeps write, search, and scope guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { confluence: { subdomain: "acme", email: "user@example.com", apiToken: "token" } } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Tools:");
    expect(prompt).not.toMatch(/^- confluence_\w+:/m);
    expect(prompt).toContain("storage-format XHTML");
    expect(prompt).toContain("rejects any mismatched");
    expect(prompt).toContain("NUMERIC `spaceId`");
    expect(prompt).toContain("resolve keys via confluence_list_spaces");
    expect(prompt).toContain("CQL primer");
    expect(prompt).toContain("sanitize agent-derived input");
    const tools = await extension.getAgentTools(
      { id: "a1", extensions: { confluence: { subdomain: "acme", email: "user@example.com", apiToken: "token" } } },
      { config: { extensions: {} } }
    );
    expect(tools.map((tool) => tool.name)).toContain("confluence_create_page");
    expect(tools.map((tool) => tool.name)).toContain("confluence_replace_page");
  });
});
