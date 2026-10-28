import { z } from "zod";

export const ConfigSchema = z.object({}).passthrough();
const date = z.string().date();
const filter = z.object({ dimension: z.enum(["page", "query", "country", "device"]), operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]), expression: z.string() }).strict();
const analyticsFields = {
  siteUrl: z.string().min(1),
  filters: z.array(filter).default([]),
  type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web"),
  dataState: z.enum(["final", "all"]).default("final"),
};
export const DATA_RULES = "GSC dates use Pacific time (America/Los_Angeles); use complete days (final by default; recent days may be incomplete). Query rows exclude anonymized queries and do not sum to page totals: use a page-only call for totals. Multi-row position must be impression-weighted. Normalize page trailing slashes and fragments before joining; never reconcile different properties. Read position and impressions deltas together; neither establishes a cause. Country example: usa; device filters: DESKTOP, MOBILE, TABLET (values pass through verbatim).";
const analyticsRow = z.object({ keys: z.array(z.string()), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() });
const period = z.object({ startDate: date, endDate: date }).strict();
const metrics = z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number().nullable() });
const comparisonRow = z.object({
  page: z.string().optional(), query: z.string().optional(), folder: z.string().nullable(), current: metrics, previous: metrics,
  clicksDelta: z.number(), impressionsDelta: z.number(), ctrDelta: z.number(), positionDelta: z.number().nullable(),
  clicksPercentDelta: z.number().nullable(), impressionsPercentDelta: z.number().nullable(), ctrPercentDelta: z.number().nullable(), positionPercentDelta: z.number().nullable(),
  status: z.enum(["new", "lost", "both"]), topQueries: z.array(z.object({ query: z.string(), clicks: z.number(), impressions: z.number(), position: z.number().nullable() })).optional(),
});
export const toolSchemas = {
  compare_periods: z.object({
    ...analyticsFields, current: period.optional(), previous: period.optional(), dimension: z.enum(["page", "query", "page+query"]).default("page"),
    minImpressions: z.number().min(0).default(0), sortBy: z.enum(["clicksDelta", "impressionsDelta", "positionDelta", "ctrDelta", "clicks"]).default("clicksDelta"),
    order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().min(1).max(500).default(50), topQueries: z.number().int().min(0).max(5).default(0),
  }).strict().describe(`Compare periods with exact tool-computed totals, weighted positions, deltas, normalized page joins, new/lost status and folder. Default: last 28 days ending three Pacific calendar days ago versus the preceding 28 days. Worst-first sorting; minImpressions applies to the larger period. topQueries (0-5, page dimension only) fetches one extra current page+query series; its first query is the primary keyword, never page totals. Fetches up to 100,000 rows per series; check meta warnings/truncated. ${DATA_RULES}`),
  list_sitemaps: z.object({ siteUrl: z.string().min(1), sitemapIndex: z.string().optional() }).strict().describe("List sitemap submission/download dates, pending state, errors and warnings for this Search Console property."),
  inspect_url: z.object({ siteUrl: z.string().min(1), inspectionUrl: z.string().url(), languageCode: z.string().min(1).optional() }).strict().describe("Inspect Google's indexing and last crawl evidence for a URL belonging to this property. URL Inspection has a small daily per-property quota."),
  list_sites: z.object({}).strict().describe("List Search Console properties visible to the connected Google account and its permission level."),
  search_analytics: z.object({
    ...analyticsFields, startDate: date, endDate: date,
    dimensions: z.array(z.enum(["page", "query", "country", "device", "date", "searchAppearance"])).default([]),
    aggregationType: z.enum(["auto", "byPage", "byProperty"]).default("auto"),
    rowLimit: z.number().int().min(1).max(25000).default(1000), startRow: z.number().int().min(0).default(0),
  }).strict().describe(`Query raw Search Analytics rows. Filters are ANDed. A full page means more rows may exist; continue at nextStartRow. ${DATA_RULES}`),
};
export const outputSchemas = {
  compare_periods: z.object({ account: z.string().nullable(), rows: z.array(comparisonRow), meta: z.object({
    current: period, previous: period, filters: z.array(filter), searchType: analyticsFields.type, dataState: analyticsFields.dataState,
    timezone: z.literal("America/Los_Angeles"), firstIncompleteDate: date.nullable(), rowsFetched: z.object({ current: z.number(), previous: z.number() }),
    rowsMatched: z.number(), rowsReturned: z.number(), truncated: z.boolean(), warnings: z.array(z.string()),
  }) }),
  list_sitemaps: z.object({ account: z.string().nullable(), sitemaps: z.array(z.object({ path: z.string(), type: z.string().nullable(), lastSubmitted: z.string().nullable(), lastDownloaded: z.string().nullable(), isPending: z.boolean(), errors: z.number(), warnings: z.number() })) }),
  inspect_url: z.object({ account: z.string().nullable(), verdict: z.string().nullable(), coverageState: z.string().nullable(), robotsTxtState: z.string().nullable(), indexingState: z.string().nullable(), lastCrawlTime: z.string().nullable(), pageFetchState: z.string().nullable(), googleCanonical: z.string().nullable(), userCanonical: z.string().nullable(), crawledAs: z.string().nullable(), sitemaps: z.array(z.string()) }),
  list_sites: z.object({ account: z.string().nullable(), sites: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })) }),
  search_analytics: z.object({ account: z.string().nullable(), rows: z.array(analyticsRow), truncated: z.boolean(), nextStartRow: z.number().nullable(), firstIncompleteDate: date.nullable() }),
};
