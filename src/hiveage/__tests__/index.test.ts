import { describe, expect, it } from "vitest";
import { ZodObject } from "zod";
import extension from "../index.js";

describe("hiveage extension", () => {
  it("keeps billing workflows and validation guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { hiveage: { apiKey: "secret", subdomain: "acme" } } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toMatch(/^- hiveage_\w+.*:/m);
    expect(prompt).toContain("connections are clients or customers");
    expect(prompt).toContain("hash keys as identifiers");
    expect(prompt).toContain("first find the connection");
    expect(prompt).toContain("required fields, dates, line items, discounts");
    expect(prompt).toContain("hiveage_list_invoices with pagination");
  });

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

  it("rejects subdomains that can redirect API credentials", () => {
    expect(() =>
      extension.createTools({
        global: {},
        agent: {},
        merged: { apiKey: "secret", subdomain: "account@attacker.example/" },
      }),
    ).toThrow();
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
