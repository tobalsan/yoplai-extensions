import { z } from "zod";
import { defineToolExtension } from "../tool-extension.js";
import { LushaClient } from "./client.js";
import {
  CompanyParamsSchema, CompanyResultSchema, EmptyParamsSchema, LushaConfigSchema,
  PersonParamsSchema, PersonResultSchema, PhoneParamsSchema, UsageResultSchema,
} from "./models.js";

export default defineToolExtension({
  id: "lusha",
  displayName: "Lusha",
  description: "Fallback person and company enrichment after People Enrich found nothing, with separate credits and opt-in phone reveals.",
  systemPrompt: `Lusha is a fallback after People Enrich. Call lusha_find_work_email only after people_enrich_find_work_email returned found: false, lusha_find_phone only after people_enrich_find_mobile returned found: false, and lusha_lookup_company only after people_enrich_lookup_company returned found: false. Never call Lusha for data People Enrich already found, and do not repeat a Lusha call whose result you already have.
Lusha has its own API key and credit pool. Costs are plan-specific, not fixed: person lookups charge a search fee plus a per-field reveal fee; no match is uncharged. Phone is the costly reveal and requires confirmCost: true; follow the agent's phone cost-approval rules. Use free lusha_credit_usage to read the account's real pricing map and balance before a phone lookup. lusha_validate is free. Both free tools share the account usage limit of 5 requests per minute; do not poll them per lookup.
Always report creditsUsed from billing, never usage deltas. found: false is normal; inspect reason, errorCode, billingStatus and missingDataPoints to distinguish no data, legal restrictions and exhausted credits. Stop and tell the user about authentication, exhausted-credit and rate-limit errors.`,
  configSchema: LushaConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const client = new LushaClient(LushaConfigSchema.parse(config.merged));
    return [
      {
        name: "find_work_email",
        description: "Find an email only after the matching People Enrich email lookup returned found: false. Reveals emails only; charges plan-specific search and email credits on a match.",
        parameters: PersonParamsSchema,
        outputSchema: PersonResultSchema,
        execute: async (params) => client.findPerson(PersonParamsSchema.parse(params), "emails"),
      },
      {
        name: "find_phone",
        description: "Find a phone only after People Enrich mobile lookup returned found: false, following the agent's phone cost-approval rules. Requires confirmCost: true; reveals phones only.",
        parameters: PhoneParamsSchema,
        outputSchema: PersonResultSchema,
        execute: async (params) => {
          const { confirmCost: _confirmCost, ...identifiers } = PhoneParamsSchema.parse(params);
          return client.findPerson(identifiers, "phones");
        },
      },
      {
        name: "lookup_company",
        description: "Find company firmographics by domain or name only after People Enrich company lookup returned found: false.",
        parameters: CompanyParamsSchema,
        outputSchema: CompanyResultSchema,
        execute: async (params) => client.findCompany(CompanyParamsSchema.parse(params)),
      },
      {
        name: "credit_usage",
        description: "Free: read Lusha credits, plan end date and per-action pricing. Shares a 5 requests/minute limit with validate.",
        parameters: EmptyParamsSchema,
        outputSchema: UsageResultSchema,
        execute: async (params) => {
          EmptyParamsSchema.parse(params);
          return client.accountUsage();
        },
      },
      {
        name: "validate",
        description: "Free: check Lusha key and reachability using account usage. Shares its 5 requests/minute limit.",
        parameters: EmptyParamsSchema,
        outputSchema: z.object({ ok: z.literal(true) }),
        execute: async (params) => {
          EmptyParamsSchema.parse(params);
          return client.validate();
        },
      },
    ];
  },
});
