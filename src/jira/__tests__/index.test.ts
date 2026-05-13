import { describe, expect, it } from "vitest";
import extension from "../index.js";
import { JiraConfigSchema } from "../models.js";

describe("jira extension", () => {
  it("parses config defaults", () => {
    expect(JiraConfigSchema.parse({ subdomain: "acme", email: "u@example.com", apiToken: "x" })).toMatchObject({ timeoutMs: 30_000, readOnly: false });
  });

  it("parses project keys from env-friendly strings", () => {
    expect(JiraConfigSchema.parse({ subdomain: "acme", email: "u@example.com", apiToken: "x", jiraProjectKeys: "CFS,CFP" }).jiraProjectKeys).toEqual(["CFS", "CFP"]);
    expect(JiraConfigSchema.parse({ subdomain: "acme", email: "u@example.com", apiToken: "x", jiraProjectKeys: '["CFS","CFP"]' }).jiraProjectKeys).toEqual(["CFS", "CFP"]);
  });

  it("hides write tools in readOnly", () => {
    const tools = extension.createTools({ global: {}, agent: {}, merged: { subdomain: "x", email: "u@example.com", apiToken: "t", readOnly: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("create_issue");
    expect(names).toContain("search");
    expect(names).toContain("validate");
  });

  it("shows write tools when not readOnly", () => {
    const tools = extension.createTools({ global: {}, agent: {}, merged: { subdomain: "x", email: "u@example.com", apiToken: "t" } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_issue");
    expect(names).toContain("update_issue");
    expect(names).toContain("add_comment");
    expect(names).toContain("transition_issue");
  });
});
