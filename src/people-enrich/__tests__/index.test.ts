import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { FindMobileParamsSchema, PeopleEnrichConfigSchema } from "../models.js";

describe("people_enrich extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the expected extension contract without provider branding", () => {
    expect(extension.id).toBe("people_enrich");
    expect(extension.displayName).toBe("People Enrich");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
    expect(`${extension.displayName} ${extension.description}`.toLowerCase()).not.toContain("firecrawl");
    expect(JSON.stringify(extension.configJsonSchema).toLowerCase()).not.toContain("firecrawl");
  });

  it("parses config defaults", () => {
    expect(PeopleEnrichConfigSchema.parse({ apiKey: "k" })).toEqual({ apiKey: "k", timeoutMs: 120_000 });
  });

  it("creates the expected tools with object parameter schemas", () => {
    const tools = extension.createTools({ global: {}, agent: {}, merged: { apiKey: "k" } });
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_people",
      "lookup_person",
      "find_work_email",
      "find_mobile",
      "reverse_email",
      "lookup_company",
      "validate",
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("requires explicit cost confirmation for mobile lookups", () => {
    expect(FindMobileParamsSchema.safeParse({ linkedinUrl: "https://linkedin.com/in/x" }).success).toBe(false);
    expect(
      FindMobileParamsSchema.safeParse({ linkedinUrl: "https://linkedin.com/in/x", confirmCost: true }).success,
    ).toBe(true);
  });

  it("resolves PEOPLE_ENRICH_* env refs and mounts prefixed tools", async () => {
    vi.stubEnv("PEOPLE_ENRICH_API_KEY", "secret");
    const agent = { id: "connie", extensions: { people_enrich: { apiKey: "$env:PEOPLE_ENRICH_API_KEY" } } };
    const tools = await extension.getAgentTools(agent, { config: {} });
    expect(tools.map((tool) => tool.name)).toContain("people_enrich_find_work_email");
    vi.unstubAllEnvs();
  });
});
