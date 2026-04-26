import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";
import extension from "../index.js";

describe("hiveage extension", () => {
  it("creates 23 tools", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { apiKey: "secret", subdomain: "acme" },
    });

    expect(tools).toHaveLength(23);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_invoices",
      "get_invoice",
      "create_invoice",
      "search_invoices",
      "list_recurring_invoices",
      "get_recurring_invoice",
      "create_recurring_invoice",
      "search_recurring_invoices",
      "list_estimates",
      "get_estimate",
      "create_estimate",
      "search_estimates",
      "list_payments",
      "get_payment",
      "create_payment",
      "list_items",
      "get_item",
      "search_items",
      "list_connections",
      "get_connection",
      "search_connections",
      "list_trash",
      "validate_estimate",
    ]);
  });

  it("uses z.object parameter schemas", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { apiKey: "secret", subdomain: "acme" },
    });

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});
