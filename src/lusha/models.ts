import { z } from "zod";

export const LushaConfigSchema = z.object({
  apiKey: z.string().min(1).describe("Lusha API key."),
  timeoutMs: z.number().int().positive().optional().describe("Request timeout in milliseconds (default 30000)."),
}).strict();

const Identifier = z.string().trim().min(1).optional();
export const PersonParamsSchema = z.object({
  linkedinUrl: z.string().url().optional().describe("LinkedIn profile URL; otherwise provide firstName, lastName and companyDomain or companyName."),
  firstName: Identifier,
  lastName: Identifier,
  companyDomain: Identifier,
  companyName: Identifier,
}).strict();

export const PhoneParamsSchema = PersonParamsSchema.extend({
  confirmCost: z.literal(true).describe("Required: confirms approval to spend phone reveal credits. Check credit_usage pricing first."),
}).strict();
export const EmptyParamsSchema = z.object({}).strict();

export const EmailSchema = z.object({
  email: z.string(), type: z.string().nullish(), confidence: z.string().nullish(),
}).passthrough();

export const PhoneSchema = z.object({
  number: z.string(), type: z.string().nullish(), doNotCall: z.boolean().nullish(),
}).passthrough();

export const PersonSchema = z.object({
  id: z.string().nullish(), firstName: z.string().nullish(), lastName: z.string().nullish(),
  fullName: z.string().nullish(),
  jobTitle: z.object({ title: z.string().nullish() }).nullish(),
  company: z.object({ id: z.string().nullish(), name: z.string().nullish(), domain: z.string().nullish(), industry: z.string().nullish() }).nullish(),
  socialLinks: z.object({ linkedin: z.string().nullish() }).nullish(),
});

const MissingDataPointsSchema = z.array(z.object({
  type: z.string(), status: z.string(), description: z.string().optional(),
}).passthrough()).optional();

export const OutcomeSchema = z.object({
  found: z.boolean(), creditsUsed: z.number(), billingStatus: z.string().optional(),
  lowBalance: z.boolean().optional(), errorCode: z.string().optional(), reason: z.string().optional(),
  missingDataPoints: MissingDataPointsSchema,
});
export const PersonResultSchema = OutcomeSchema.extend({
  emails: z.array(EmailSchema).optional(),
  phones: z.array(PhoneSchema).optional(), person: PersonSchema.optional(),
});

export const PersonResponseSchema = z.object({
  results: z.array(PersonSchema.extend({
    emails: z.array(EmailSchema).optional(), phones: z.array(PhoneSchema).optional(),
    error: z.object({ code: z.string() }).optional(),
    missingDataPoints: MissingDataPointsSchema,
  })),
  billing: z.object({ creditsCharged: z.number(), status: z.string().optional(), lowBalance: z.boolean().optional() }),
});

export type LushaConfig = z.infer<typeof LushaConfigSchema>;
export type PersonParams = z.infer<typeof PersonParamsSchema>;

export const CompanyParamsSchema = z.object({
  domain: Identifier.describe("Company domain, or provide name."), name: Identifier,
}).strict();
export type CompanyParams = z.infer<typeof CompanyParamsSchema>;

export const CompanySchema = z.object({
  id: z.string().nullish(), name: z.string().nullish(), domain: z.string().nullish(), industry: z.string().nullish(),
  employeeCount: z.object({ exact: z.number().nullish(), min: z.number().nullish(), max: z.number().nullish() }).nullish(),
  location: z.object({ city: z.string().nullish(), state: z.string().nullish(), country: z.string().nullish() }).nullish(),
  description: z.string().nullish(), yearFounded: z.number().nullish(),
  socialLinks: z.object({ linkedin: z.string().nullish() }).nullish(),
});
export const CompanyResultSchema = OutcomeSchema.extend({ company: CompanySchema.optional() });
export const CompanyResponseSchema = z.object({
  results: z.array(CompanySchema.extend({
    error: z.object({ code: z.string() }).optional(), missingDataPoints: MissingDataPointsSchema,
  })),
  billing: PersonResponseSchema.shape.billing,
});

export const UsageResultSchema = z.object({
  credits: z.object({ total: z.number(), used: z.number(), remaining: z.number() }),
  plan: z.object({ category: z.string().optional(), endDate: z.string().nullish() }).passthrough(),
  pricing: z.record(z.object({ credits: z.number(), perQuantity: z.number() }).passthrough()),
  rateLimits: z.record(z.unknown()).optional(),
});
