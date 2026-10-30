import { describe, expect, it } from "vitest";

import extension from "../index.js";

describe("pennylane extension", () => {
  it("keeps pagination, deduplication, and draft safety guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { pennylane: { apiToken: "test-token" } } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toMatch(/^- pennylane_\w+.*:/m);
    expect(prompt).toContain("money values are decimal strings");
    expect(prompt).toContain("cursor pagination is walked transparently");
    expect(prompt).toContain("refusing to touch a finalized invoice");
    expect(prompt).toContain("before creating, look up by external_reference");
    expect(prompt).toContain("NO quote accept/status/send tool");
    expect(prompt).toContain("retries on 429");
    expect(prompt).toContain("READ-ONLY by default");
    expect(prompt).toContain("never claim a write was applied");
  });
});

const READ_TOOLS = [
  "validate", "list_invoices", "search_invoices", "get_invoice", "list_quotes", "search_quotes", "get_quote",
  "list_customers", "search_customers", "get_customer", "list_products", "search_products", "get_product",
  "list_vat_rates",
];
const WRITE_TOOLS = ["create_customer", "create_invoice_draft", "update_invoice_draft", "create_quote", "update_quote"];
const names = (merged: Record<string, unknown>) =>
  extension.createTools({ global: {}, agent: {}, merged: { apiToken: "t", ...merged } }).map((tool) => tool.name);

describe("pennylane allowWrite gating", () => {
  it("exposes only read tools by default or when allowWrite is false", () => {
    expect(names({})).toEqual(READ_TOOLS);
    expect(names({ allowWrite: false })).toEqual(READ_TOOLS);
  });

  it("exposes all 19 tools when allowWrite is true", () => {
    const all = names({ allowWrite: true });
    expect(all).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    expect(all).toHaveLength(19);
  });
});
