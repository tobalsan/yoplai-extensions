import { z } from "zod";

const NonNegativeIntegerString = z.string().transform((value, ctx) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected non-negative integer",
    });
    return z.NEVER;
  }
  return parsed;
});

const OptionalNumber = z
  .union([z.number().int().nonnegative(), NonNegativeIntegerString])
  .optional();

const JsonObject = z.record(z.unknown());
const JsonArray = z.array(z.unknown());

const JsonObjectString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON object",
      });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON object string",
    });
    return z.NEVER;
  }
});

const JsonArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON array",
      });
      return z.NEVER;
    }
    return parsed;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON array string",
    });
    return z.NEVER;
  }
});

const StringArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === "string" && item.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON string array",
      });
      return z.NEVER;
    }
    return parsed as string[];
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON string array",
    });
    return z.NEVER;
  }
});

const JsonObjectInput = z.union([JsonObject, JsonObjectString]);
const JsonArrayInput = z.union([JsonArray, JsonArrayString]);
const StringArrayInput = z.union([z.array(z.string().min(1)).min(1), StringArrayString]);

export const FirecrawlConfigSchema = z.object({
  apiKey: z.string().describe("Firecrawl API key, e.g. fc-xxxxxxxx. Get one at firecrawl.dev/app/api-keys."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(60_000)
    .describe("Default request timeout in milliseconds for Firecrawl API calls. Defaults to 60000."),
});

export const ScrapeParamsSchema = z
  .object({
    url: z.string().min(1).describe("URL of the page to scrape."),
    formats: JsonArrayInput.optional().describe(
      'Output formats, e.g. ["markdown", "links", "screenshot", "html"]. Entries may be strings or {type} objects. Defaults to ["markdown"].',
    ),
    onlyMainContent: z
      .boolean()
      .optional()
      .describe("Strip nav, headers, and footers. Defaults to true."),
    includeTags: StringArrayInput.optional().describe("Only include these HTML tags."),
    excludeTags: StringArrayInput.optional().describe("Exclude these HTML tags."),
    waitFor: OptionalNumber.describe("Delay in ms before capture. Defaults to 0."),
    timeout: OptionalNumber.describe("Scrape timeout in ms (1000-300000). Defaults to 60000."),
    maxAge: OptionalNumber.describe(
      "Serve from cache if fresher than this many ms. Defaults to 2 days; pass 0 to force a fresh scrape.",
    ),
    mobile: z.boolean().optional().describe("Emulate a mobile device. Defaults to false."),
    headers: JsonObjectInput.optional().describe("Custom request headers."),
    actions: JsonArrayInput.optional().describe(
      "Browser steps before capture: click/write/scroll/wait/executeJavascript/screenshot.",
    ),
    proxy: z.enum(["basic", "enhanced", "auto"]).optional().describe("Proxy mode. Defaults to auto."),
    country: z.string().optional().describe("ISO country code for request origin. Defaults to US."),
    languages: StringArrayInput.optional().describe(
      'Preferred languages for the request origin, e.g. ["en", "fr"].',
    ),
    blockAds: z.boolean().optional().describe("Block ads while loading. Defaults to true."),
    parsers: JsonArrayInput.optional().describe(
      'Document parsers, e.g. [{"type": "pdf", "parsePDF": "auto"}] (modes: fast, auto, ocr). Defaults to [{"type": "pdf"}].',
    ),
  })
  .strict();

export const SearchParamsSchema = z
  .object({
    query: z.string().min(1).max(500).describe("Search query."),
    limit: OptionalNumber.describe("Results per source (1-100). Defaults to 10."),
    sources: StringArrayInput.optional().describe(
      'Result sources: "web", "images", "news". Defaults to ["web"].',
    ),
    categories: StringArrayInput.optional().describe(
      'Optional category filters: "github", "research", "pdf".',
    ),
    tbs: z
      .string()
      .optional()
      .describe("Time filter: qdr:h (hour), qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)."),
    location: z
      .string()
      .optional()
      .describe('Geographic origin, e.g. "San Francisco,California,United States".'),
    country: z.string().optional().describe("ISO country code. Defaults to US."),
    timeout: OptionalNumber.describe("Search timeout in ms. Defaults to 60000."),
    includeDomains: StringArrayInput.optional().describe("Only return results from these hostnames."),
    excludeDomains: StringArrayInput.optional().describe("Exclude results from these hostnames."),
    ignoreInvalidURLs: z.boolean().optional().describe("Skip invalid URLs. Defaults to false."),
    scrapeFormats: StringArrayInput.optional().describe(
      'If set, scrape each result and return content in these formats (e.g. ["markdown"]). Omit for fast SERP-only results (titles and descriptions).',
    ),
    scrapeOptions: JsonObjectInput.optional().describe(
      "Full scrape options applied to each result (formats, onlyMainContent, maxAge, ...). Passed through verbatim; merged over scrapeFormats.",
    ),
  })
  .strict();

export const MapParamsSchema = z
  .object({
    url: z.string().min(1).describe("Base URL of the site to map."),
    search: z.string().optional().describe("Rank discovered links by relevance to this query."),
    limit: OptionalNumber.describe("Max links to return (max 100000). Defaults to 5000."),
    sitemap: z
      .enum(["skip", "include", "only"])
      .optional()
      .describe("Sitemap usage. Defaults to include."),
    includeSubdomains: z.boolean().optional().describe("Include subdomain links. Defaults to true."),
    ignoreQueryParameters: z
      .boolean()
      .optional()
      .describe("Treat URLs differing only by query string as one. Defaults to true."),
    timeout: OptionalNumber.describe("Map timeout in ms."),
    country: z.string().optional().describe("ISO country code for request origin. Defaults to US."),
    languages: StringArrayInput.optional().describe(
      'Preferred languages for the request origin, e.g. ["en", "fr"].',
    ),
  })
  .strict();

export const CrawlParamsSchema = z
  .object({
    url: z.string().min(1).describe("Start URL of the crawl."),
    limit: z
      .union([z.number().int().positive(), NonNegativeIntegerString])
      .optional()
      .default(100)
      .describe("Max pages to crawl. Defaults to 100."),
    prompt: z
      .string()
      .optional()
      .describe("Natural-language crawler instructions; Firecrawl derives crawl options from it."),
    maxDiscoveryDepth: OptionalNumber.describe("Max link-discovery depth from the start URL."),
    includePaths: StringArrayInput.optional().describe("Pathname regex patterns to include."),
    excludePaths: StringArrayInput.optional().describe("Pathname regex patterns to exclude."),
    sitemap: z
      .enum(["skip", "include", "only"])
      .optional()
      .describe("Sitemap usage. Defaults to include."),
    crawlEntireDomain: z
      .boolean()
      .optional()
      .describe("Follow parent/sibling paths, not just children. Defaults to false."),
    allowSubdomains: z.boolean().optional().describe("Follow subdomain links. Defaults to false."),
    allowExternalLinks: z
      .boolean()
      .optional()
      .describe("Follow external links. Defaults to false."),
    ignoreQueryParameters: z
      .boolean()
      .optional()
      .describe("Treat URLs differing only by query string as one. Defaults to false."),
    delay: z.number().nonnegative().optional().describe("Delay in seconds between page scrapes."),
    maxConcurrency: OptionalNumber.describe("Max concurrent scrapes. Defaults to the team limit."),
    scrapeFormats: StringArrayInput.optional().describe(
      'Per-page output formats (e.g. ["markdown"]). Defaults to markdown.',
    ),
    scrapeOptions: JsonObjectInput.optional().describe(
      "Full per-page scrape options (formats, onlyMainContent, maxAge, ...). Passed through verbatim; merged over scrapeFormats.",
    ),
    webhook: z
      .union([z.string(), JsonObjectInput])
      .optional()
      .describe(
        "Webhook notified of crawl events: a URL string or {url, headers, metadata, events}.",
      ),
  })
  .strict();

export const MonitorParamsSchema = z
  .object({
    jobId: z.string().min(1).describe("Crawl job id returned by firecrawl_crawl."),
    autoPaginate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Follow pagination `next` links and merge all page data. Defaults to true."),
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export const CrawlCancelParamsSchema = z
  .object({
    jobId: z.string().min(1).describe("Crawl job id to cancel."),
  })
  .strict();

export type FirecrawlConfig = z.infer<typeof FirecrawlConfigSchema>;
export type ScrapeParams = z.infer<typeof ScrapeParamsSchema>;
export type SearchParams = z.infer<typeof SearchParamsSchema>;
export type MapParams = z.infer<typeof MapParamsSchema>;
export type CrawlParams = z.infer<typeof CrawlParamsSchema>;
export type MonitorParams = z.infer<typeof MonitorParamsSchema>;
export type CrawlCancelParams = z.infer<typeof CrawlCancelParamsSchema>;
