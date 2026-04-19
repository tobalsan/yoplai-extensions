import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";

import connector from "../index.js";

describe("gsheets connector", () => {
  it("exports the expected connector contract", () => {
    expect(connector.id).toBe("gsheets");
    expect(connector.requiredSecrets).toEqual(["serviceAccountJson"]);
  });

  it("creates 5 tools with object parameter schemas", () => {
    const tools = connector.createTools({
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
