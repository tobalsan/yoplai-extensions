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

it("declares useful search, profile and email fields including normal misses", async () => {
  const tools = extension.createTools({ global: {}, agent: {}, merged: { apiKey: "fixture" } });
  const attempts = [{ provider: "fullenrich", creditsUsed: 20, found: true }];
  const profile = { name: "Sam Example", currentCompany: "Acme", experience: [{ title: "CTO", company: "Acme", start: "2022-01", end: "present" }] };
  const examples: Record<string, unknown[]> = {
    search_people: [{ provider: "apollo", creditsUsed: 0, totalMatches: 1, people: [{ apolloId: "p1", firstName: "Sam", lastNameMasked: "E***", hasEmail: true, hasDirectPhone: "maybe" }] }, { provider: "apollo", creditsUsed: 0, totalMatches: 0, people: [] }],
    lookup_person: [{ found: true, provider: "fullenrich", creditsUsed: 5, attempts: [{ provider: "fullenrich", creditsUsed: 5, found: true }], person: profile }, { found: false, creditsUsed: 0, attempts: [], person: null }],
    find_work_email: [{ found: true, provider: "fullenrich", creditsUsed: 20, attempts, email: "sam@example.test", emailStatus: "DELIVERABLE", otherEmails: [], person: profile },
      { found: true, provider: "datalegion", creditsUsed: 50, attempts: [{ provider: "datalegion", creditsUsed: 50, found: true }], email: "sam@example.test", emailStatus: null, otherEmails: [undefined, "other@example.test"], person: null },
      { found: true, provider: "datalegion", creditsUsed: 50, attempts: [{ provider: "datalegion", creditsUsed: 50, found: true }], email: "sam@example.test", emailStatus: null, otherEmails: [null, "other@example.test"], person: null },
      { found: false, creditsUsed: 0, attempts: [], email: null }],
  };
  const mounted = await extension.getAgentTools({ id: "a", extensions: { people_enrich: { apiKey: "fixture" } } }, { config: {} });
  for (const [name, fixtures] of Object.entries(examples)) {
    const schema = tools.find((tool) => tool.name === name)!.outputSchema;
    expect(schema, name).toBeDefined();
    for (const fixture of fixtures) expect(schema!.safeParse(fixture).success, name).toBe(true);
    expect(mounted.find((tool) => tool.name === `people_enrich_${name}`)).toHaveProperty("outputSchema.type", "object");
  }
});
