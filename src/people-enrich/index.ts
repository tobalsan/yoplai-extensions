import { PeopleEnrichClient } from "./client.js";
import {
  FindMobileParamsSchema,
  FindWorkEmailParamsSchema,
  LookupCompanyParamsSchema,
  LookupPersonParamsSchema,
  PeopleEnrichConfigSchema,
  ReverseEmailParamsSchema,
  SearchPeopleParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "people_enrich",
  displayName: "People Enrich",
  description: "Find people and companies, then enrich them with profiles, work emails and mobile numbers.",
  systemPrompt: `Use this extension to identify and enrich leads. Each tool tries several data sources cheapest-first and stops at the first hit; most sources bill only when they find something. Every result reports creditsUsed and attempts; always tell the user what each call cost.
Workflow:
1. people_enrich_search_people (free) to find candidates by name/company/title. Last names are masked; several people often share a name — confirm the right one (company, title) before paying.
2. people_enrich_lookup_person (5 credits typical, up to 30; only one source ever bills) for a profile without contact data.
3. people_enrich_find_work_email (20 credits typical, up to 80). Pass apolloId only when the search candidate had hasEmail=true — Apollo bills 30 for a matched person even when no email is unlocked.
4. people_enrich_find_mobile (50 credits typical, up to 175) only after the user explicitly approves the cost.
people_enrich_reverse_email (10 credits typical, up to 30) identifies the person behind an email; people_enrich_lookup_company (5 credits typical, up to 30) returns firmographics.
Strip accents from names (Éric → Eric). Never repeat a paid call whose result you already have. found=false is a normal outcome, not an error.`,
  configSchema: PeopleEnrichConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const resolved = PeopleEnrichConfigSchema.parse(config.merged);
    const client = new PeopleEnrichClient(resolved);

    return [
      {
        name: "search_people",
        description:
          "Free. Search people by name, company domain, title or location. Returns candidates with apolloId, masked last name, title and company.",
        parameters: SearchPeopleParamsSchema,
        execute: async (params) => await client.searchPeople(SearchPeopleParamsSchema.parse(params)),
      },
      {
        name: "lookup_person",
        description:
          "Professional profile (headline, location, current role, work history, LinkedIn) from a LinkedIn URL or name + company. No contact data. Billed only by the source that matches: 5, else 10, else 30; misses are free.",
        parameters: LookupPersonParamsSchema,
        execute: async (params) => await client.lookupPerson(LookupPersonParamsSchema.parse(params)),
      },
      {
        name: "find_work_email",
        description:
          "Verified work email from a LinkedIn URL or first/last name + company. Sources in order: 20 credits when an email is found; Apollo by apolloId (30 per matched person, even without an email); 50 credits only when an email exists; Apollo by name/LinkedIn as last resort when no apolloId (30 per matched person). Typical 20, worst 80.",
        parameters: FindWorkEmailParamsSchema,
        execute: async (params) => await client.findWorkEmail(FindWorkEmailParamsSchema.parse(params)),
      },
      {
        name: "find_mobile",
        description:
          "EXPENSIVE: mobile phone number from a LinkedIn URL or name + company. 50 credits when the first source has it, otherwise 175 when found; misses are free. Only call after the user approved up to 175 credits; set confirmCost=true.",
        parameters: FindMobileParamsSchema,
        execute: async (params) => await client.findMobile(FindMobileParamsSchema.parse(params)),
      },
      {
        name: "reverse_email",
        description: "Identify the person and company behind an email address. Billed only by the source that matches: 10, else 20, else 30; misses are free.",
        parameters: ReverseEmailParamsSchema,
        execute: async (params) => await client.reverseEmail(ReverseEmailParamsSchema.parse(params)),
      },
      {
        name: "lookup_company",
        description:
          "Company firmographics (industry, headcount, HQ, founding year, description) from a domain or LinkedIn URL. Billed only by the source that matches: 5, else 10, else 30; misses are free.",
        parameters: LookupCompanyParamsSchema,
        execute: async (params) => await client.lookupCompany(LookupCompanyParamsSchema.parse(params)),
      },
      {
        name: "validate",
        description: "Free. Validate configuration and API reachability.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
    ];
  },
});
