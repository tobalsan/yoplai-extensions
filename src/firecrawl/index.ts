import { FirecrawlClient } from "./client.js";
import {
  CrawlCancelParamsSchema,
  CrawlParamsSchema,
  FirecrawlConfigSchema,
  MapParamsSchema,
  MonitorParamsSchema,
  ScrapeParamsSchema,
  SearchParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "firecrawl",
  displayName: "Firecrawl",
  description: "Web scraping, search, site mapping, and crawling via the Firecrawl API.",
  systemPrompt: `Use this extension to read and search the web via Firecrawl: scrape a single page to markdown, run web searches, map a site's URLs, or crawl an entire site. firecrawl_crawl is asynchronous — it returns a job id immediately; poll firecrawl_monitor with that id every few seconds until status is "completed" or "failed". Crawl results expire roughly 24 hours after completion. Return and consume JSON-serializable data only.`,
  configSchema: FirecrawlConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const resolved = FirecrawlConfigSchema.parse(config.merged);
    const client = new FirecrawlClient(resolved);

    return [
      {
        name: "scrape",
        description: "Scrape a single URL and return its content (markdown by default).",
        parameters: ScrapeParamsSchema,
        execute: async (params) => {
          const parsed = ScrapeParamsSchema.parse(params);
          return await client.scrape(parsed);
        },
      },
      {
        name: "search",
        description:
          "Search the web (optionally images/news) and return results; set scrapeFormats to also fetch page content.",
        parameters: SearchParamsSchema,
        execute: async (params) => {
          const parsed = SearchParamsSchema.parse(params);
          return await client.search(parsed);
        },
      },
      {
        name: "map",
        description: "Map a website and return its discovered URLs (fast, no page content).",
        parameters: MapParamsSchema,
        execute: async (params) => {
          const parsed = MapParamsSchema.parse(params);
          return await client.map(parsed);
        },
      },
      {
        name: "crawl",
        description:
          "Start an asynchronous crawl of a website; returns a job id immediately. Use firecrawl_monitor to poll status and fetch results.",
        parameters: CrawlParamsSchema,
        execute: async (params) => {
          const parsed = CrawlParamsSchema.parse(params);
          return await client.crawl(parsed);
        },
      },
      {
        name: "monitor",
        description:
          "Check the status and results of a crawl job by id. Auto-follows pagination and merges all page data by default.",
        parameters: MonitorParamsSchema,
        execute: async (params) => {
          const parsed = MonitorParamsSchema.parse(params);
          return await client.getCrawlStatus(parsed);
        },
      },
      {
        name: "validate",
        description: "Validate configuration and API reachability.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
      {
        name: "crawl_cancel",
        description: "Cancel an in-progress crawl job by id.",
        parameters: CrawlCancelParamsSchema,
        execute: async (params) => {
          const parsed = CrawlCancelParamsSchema.parse(params);
          return await client.cancelCrawl(parsed);
        },
      },
    ];
  },
});
