import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";

describe("gsheets extension", () => {
  it("keeps authentication, large-tab, and write guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { gsheets: { serviceAccountJson: "test-credentials" } } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Tools:");
    expect(prompt).not.toMatch(/^- gsheets_\w+:/m);
    expect(prompt).toContain("Do not ask for or inspect Google service account environment variables");
    expect(prompt).toContain("Use rowOffset, maxRows, and columns to limit large tabs");
    expect(prompt).toContain("Before writing, read the target tab or range");
    expect(prompt).toContain("report the updated range and cell count");
  });

  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("gsheets");
    expect(extension.requiredSecrets).toEqual(["serviceAccountJson"]);
  });

  it("creates 7 tools with object parameter schemas", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: {
        serviceAccountJson: JSON.stringify({
          client_email: "service@example.com",
          private_key: "private",
        }),
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_spreadsheets",
      "inspect_spreadsheet",
      "read_sheet",
      "read_range",
      "append_rows",
      "update_range",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});
