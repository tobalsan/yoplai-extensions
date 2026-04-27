import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";
import extension from "../index.js";

describe("zendesk extension", () => {
  it("creates 3 tools", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { subdomain: "acme", email: "agent@acme.com", apiKey: "secret" },
    });

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_tickets",
      "search_tickets",
      "get_ticket",
    ]);
  });

  it("uses z.object parameter schemas", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { subdomain: "acme", email: "agent@acme.com", apiKey: "secret" },
    });

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});
