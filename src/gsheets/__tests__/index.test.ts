import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";

describe("gsheets extension", () => {
  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("gsheets");
    expect(extension.requiredSecrets).toEqual(["serviceAccountJson"]);
  });

  it("creates 5 tools with object parameter schemas", () => {
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
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});
