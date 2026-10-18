import { z } from "zod";

const StringArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && item.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected JSON string array" });
      return z.NEVER;
    }
    return parsed as string[];
  } catch {
    // A bare string is treated as a single-item list.
    return [value];
  }
});

const StringArrayInput = z.union([z.array(z.string().min(1)).min(1), StringArrayString]);

const PositiveIntInput = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

export const PeopleEnrichConfigSchema = z.object({
  apiKey: z.string().describe("People Enrich API key."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(120_000)
    .describe("Request timeout in milliseconds. Contact lookups can take a minute. Defaults to 120000."),
});

export const SearchPeopleParamsSchema = z
  .object({
    name: z.string().optional().describe('Person name or keywords, e.g. "Eric Ingrand". Strip accents (Éric → Eric): accented names often return nothing.'),
    companyDomains: StringArrayInput.optional().describe('Employer domains to filter on, e.g. ["acme.com"].'),
    titles: StringArrayInput.optional().describe('Job titles to filter on, e.g. ["CMO", "Head of IT"].'),
    locations: StringArrayInput.optional().describe('Locations, e.g. ["France", "Paris"].'),
    page: PositiveIntInput.optional().describe("Page number (1-based). Defaults to 1."),
    perPage: PositiveIntInput.optional().describe("Results per page (max 100). Defaults to 25."),
  })
  .strict();

export const LookupPersonParamsSchema = z
  .object({
    linkedinUrl: z.string().optional().describe("LinkedIn profile URL. Most reliable identifier."),
    name: z.string().optional().describe("Full name. Requires companyDomain or companyName when no linkedinUrl."),
    companyDomain: z.string().optional().describe('Employer domain, e.g. "stripe.com". Preferred over companyName.'),
    companyName: z.string().optional().describe("Employer name, when the domain is unknown."),
  })
  .strict();

export const FindWorkEmailParamsSchema = z
  .object({
    linkedinUrl: z.string().optional().describe("LinkedIn profile URL. Most reliable identifier."),
    firstName: z.string().optional().describe("First name (with lastName + companyDomain or companyName when no linkedinUrl)."),
    lastName: z.string().optional().describe("Last name."),
    companyDomain: z.string().optional().describe('Employer domain, e.g. "acme.com".'),
    companyName: z.string().optional().describe("Employer name, when the domain is unknown."),
    apolloId: z
      .string()
      .optional()
      .describe("Apollo id from search_people. Pass it only when that candidate had hasEmail=true: Apollo is then tried right after the first source (30 credits per matched person, billed even when no email is unlocked)."),
  })
  .strict();

export const FindMobileParamsSchema = z
  .object({
    linkedinUrl: z.string().optional().describe("LinkedIn profile URL. Most reliable identifier."),
    firstName: z.string().optional().describe("First name."),
    lastName: z.string().optional().describe("Last name."),
    companyDomain: z.string().optional().describe("Employer domain."),
    companyName: z.string().optional().describe("Employer name."),
    confirmCost: z
      .literal(true)
      .describe("Must be true. Confirms the user approved paying up to 175 credits for a found mobile number."),
  })
  .strict();

export const ReverseEmailParamsSchema = z
  .object({
    email: z.string().email().describe("Work or personal email address to identify."),
  })
  .strict();

export const LookupCompanyParamsSchema = z
  .object({
    domain: z.string().optional().describe('Company domain, e.g. "acme.com".'),
    linkedinUrl: z.string().optional().describe("Company LinkedIn URL."),
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export type PeopleEnrichConfig = z.infer<typeof PeopleEnrichConfigSchema>;
export type SearchPeopleParams = z.infer<typeof SearchPeopleParamsSchema>;
export type LookupPersonParams = z.infer<typeof LookupPersonParamsSchema>;
export type FindWorkEmailParams = z.infer<typeof FindWorkEmailParamsSchema>;
export type FindMobileParams = z.infer<typeof FindMobileParamsSchema>;
export type ReverseEmailParams = z.infer<typeof ReverseEmailParamsSchema>;
export type LookupCompanyParams = z.infer<typeof LookupCompanyParamsSchema>;

const PersonResultSchema = z.object({
  apolloId: z.string().optional(),
  name: z.string().optional(),
  headline: z.string().optional(),
  about: z.string().optional(),
  location: z.string().optional(),
  currentTitle: z.string().optional(),
  currentCompany: z.string().optional(),
  currentCompanyDomain: z.string().optional(),
  linkedinUrl: z.string().optional(),
  experience: z.array(z.object({
    title: z.string().optional(), company: z.string().optional(), domain: z.string().optional(),
    start: z.string().optional(), end: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();
const EnrichmentResultSchema = z.object({
  found: z.boolean(),
  provider: z.string().optional(),
  creditsUsed: z.number(),
  attempts: z.array(z.object({
    provider: z.string(), creditsUsed: z.number(), found: z.boolean(), error: z.string().optional(),
  })),
});
export const SearchPeopleResultSchema = z.object({
  provider: z.string(),
  creditsUsed: z.number(),
  totalMatches: z.number(),
  people: z.array(z.object({
    apolloId: z.string().optional(), firstName: z.string().optional(), lastNameMasked: z.string().optional(),
    title: z.string().optional(), company: z.string().optional(), hasEmail: z.boolean().nullable().optional(),
    hasDirectPhone: z.union([z.boolean(), z.string()]).nullable().optional(),
  })),
});
export const LookupPersonResultSchema = EnrichmentResultSchema.extend({ person: PersonResultSchema.nullable() });
export const FindWorkEmailResultSchema = EnrichmentResultSchema.extend({
  email: z.string().nullable(),
  emailStatus: z.string().nullable().optional(),
  otherEmails: z.array(z.string().nullish()).optional(),
  person: PersonResultSchema.nullable().optional(),
});
