import { z } from "zod";

const PositiveIntegerString = z.string().transform((value, ctx) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected positive integer",
    });
    return z.NEVER;
  }
  return parsed;
});

const OptionalNumber = z
  .union([z.number().int().positive(), PositiveIntegerString])
  .optional();

export const ExaConfigSchema = z.object({
  apiKey: z.string(),
});

export const SearchTypeSchema = z.enum(["auto", "fast", "deep"]);
export const LivecrawlSchema = z.enum(["fallback", "preferred"]);
export const LinkedinSearchTypeSchema = z.enum(["profiles", "companies", "all"]);
export const ResearchModelSchema = z.enum(["exa-research", "exa-research-pro"]);

export const SearchParamsSchema = z
  .object({
    query: z.string().min(1),
    numResults: OptionalNumber.describe("Number of results to return (default 8)."),
    type: SearchTypeSchema.optional().describe(
      'Search type: "auto" (default), "fast" for low latency, "deep" for thoroughness.',
    ),
    livecrawl: LivecrawlSchema.optional().describe(
      'Live crawling: "fallback" (default, crawl only when cache misses) or "preferred".',
    ),
    maxCharacters: OptionalNumber.describe(
      "Max characters of page text per result (default 10000).",
    ),
  })
  .strict();

export const CodeParamsSchema = z
  .object({
    query: z.string().min(1).describe("Programming question or library/API to get context for."),
    tokens: OptionalNumber.describe(
      "Context size in tokens, between 1000 and 50000 (default 5000).",
    ),
  })
  .strict();

export const DeepSearchParamsSchema = z
  .object({
    query: z.string().min(1).describe("Research objective to investigate in depth."),
    numResults: OptionalNumber.describe("Number of results to return (default 8)."),
  })
  .strict();

export const CrawlParamsSchema = z
  .object({
    url: z.string().min(1).describe("URL of the page to crawl."),
    maxCharacters: OptionalNumber.describe(
      "Max characters of page text to return (default 3000).",
    ),
  })
  .strict();

export const CompanyParamsSchema = z
  .object({
    company: z.string().min(1).describe("Company name to research."),
    numResults: OptionalNumber.describe("Number of results to return (default 5)."),
  })
  .strict();

export const LinkedinParamsSchema = z
  .object({
    query: z.string().min(1).describe("Person or company to look up on LinkedIn."),
    type: LinkedinSearchTypeSchema.optional().describe(
      'Restrict to "profiles" or "companies"; "all" (default) searches both.',
    ),
    numResults: OptionalNumber.describe("Number of results to return (default 5)."),
  })
  .strict();

export const ResearchStartParamsSchema = z
  .object({
    instructions: z.string().min(1).describe("Research instructions for the async task."),
    model: ResearchModelSchema.optional().describe(
      'Research model: "exa-research" (default) or "exa-research-pro" (more thorough).',
    ),
  })
  .strict();

export const ResearchCheckParamsSchema = z
  .object({
    taskId: z.string().min(1).describe("Task id returned by exa_research_start."),
  })
  .strict();

export type ExaConfig = z.infer<typeof ExaConfigSchema>;
export type SearchParams = z.infer<typeof SearchParamsSchema>;
export type CodeParams = z.infer<typeof CodeParamsSchema>;
export type DeepSearchParams = z.infer<typeof DeepSearchParamsSchema>;
export type CrawlParams = z.infer<typeof CrawlParamsSchema>;
export type CompanyParams = z.infer<typeof CompanyParamsSchema>;
export type LinkedinParams = z.infer<typeof LinkedinParamsSchema>;
export type ResearchStartParams = z.infer<typeof ResearchStartParamsSchema>;
export type ResearchCheckParams = z.infer<typeof ResearchCheckParamsSchema>;

export const ValidateParamsSchema = z.object({}).strict();
export type ValidateParams = z.infer<typeof ValidateParamsSchema>;
