import { describe, expect, it } from "vitest";
import {
  CrawlParamsSchema,
  FirecrawlConfigSchema,
  MapParamsSchema,
  MonitorParamsSchema,
  ScrapeParamsSchema,
  SearchParamsSchema,
} from "../models.js";

describe("firecrawl models", () => {
  it("parses config defaults", () => {
    expect(
      FirecrawlConfigSchema.parse({
        apiKey: "fc-secret",
      }),
    ).toEqual({
      apiKey: "fc-secret",
      timeoutMs: 60_000,
    });
  });

  it("parses tool parameter schemas", () => {
    expect(
      ScrapeParamsSchema.parse({
        url: "https://example.com",
        formats: ["markdown", "links"],
        onlyMainContent: true,
        includeTags: ["article"],
        excludeTags: ["nav"],
        waitFor: 500,
        timeout: 30_000,
        maxAge: 0,
        mobile: false,
        headers: { "X-Test": "1" },
        actions: [{ type: "wait", milliseconds: 100 }],
        proxy: "auto",
        country: "FR",
        blockAds: true,
      }),
    ).toEqual({
      url: "https://example.com",
      formats: ["markdown", "links"],
      onlyMainContent: true,
      includeTags: ["article"],
      excludeTags: ["nav"],
      waitFor: 500,
      timeout: 30_000,
      maxAge: 0,
      mobile: false,
      headers: { "X-Test": "1" },
      actions: [{ type: "wait", milliseconds: 100 }],
      proxy: "auto",
      country: "FR",
      blockAds: true,
    });

    expect(
      SearchParamsSchema.parse({
        query: "firecrawl extension",
        limit: 5,
        sources: ["web", "news"],
        tbs: "qdr:w",
        country: "US",
        scrapeFormats: ["markdown"],
      }),
    ).toEqual({
      query: "firecrawl extension",
      limit: 5,
      sources: ["web", "news"],
      tbs: "qdr:w",
      country: "US",
      scrapeFormats: ["markdown"],
    });

    expect(
      MapParamsSchema.parse({
        url: "https://example.com",
        search: "docs",
        limit: 100,
        sitemap: "include",
        includeSubdomains: false,
        ignoreQueryParameters: true,
      }),
    ).toEqual({
      url: "https://example.com",
      search: "docs",
      limit: 100,
      sitemap: "include",
      includeSubdomains: false,
      ignoreQueryParameters: true,
    });

    expect(
      CrawlParamsSchema.parse({
        url: "https://example.com",
        prompt: "Extract all docs pages",
        maxDiscoveryDepth: 2,
        includePaths: ["^/docs"],
        excludePaths: ["^/blog"],
        sitemap: "skip",
        crawlEntireDomain: true,
        allowSubdomains: false,
        allowExternalLinks: false,
        ignoreQueryParameters: true,
        delay: 1.5,
        maxConcurrency: 3,
        scrapeFormats: ["markdown"],
      }),
    ).toMatchObject({
      url: "https://example.com",
      limit: 100,
      includePaths: ["^/docs"],
      delay: 1.5,
      scrapeFormats: ["markdown"],
    });

    expect(MonitorParamsSchema.parse({ jobId: "job-123" })).toEqual({
      jobId: "job-123",
      autoPaginate: true,
    });
    expect(MonitorParamsSchema.parse({ jobId: "job-123", autoPaginate: false })).toEqual({
      jobId: "job-123",
      autoPaginate: false,
    });
  });

  it("applies the crawl limit default", () => {
    expect(CrawlParamsSchema.parse({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
      limit: 100,
    });
  });

  it("rejects unknown keys on strict schemas", () => {
    expect(() => ScrapeParamsSchema.parse({ url: "https://example.com", extra: true })).toThrow();
    expect(() => SearchParamsSchema.parse({ query: "test", extra: true })).toThrow();
    expect(() => MapParamsSchema.parse({ url: "https://example.com", extra: true })).toThrow();
    expect(() => CrawlParamsSchema.parse({ url: "https://example.com", extra: true })).toThrow();
    expect(() => MonitorParamsSchema.parse({ jobId: "job-123", extra: true })).toThrow();
  });

  it("accepts JSON-encoded and numeric-string tool arguments", () => {
    expect(
      ScrapeParamsSchema.parse({
        url: "https://example.com",
        formats: JSON.stringify(["markdown", { type: "screenshot" }]),
        includeTags: JSON.stringify(["article", "main"]),
        headers: JSON.stringify({ "X-Test": "1" }),
        waitFor: "250",
      }),
    ).toMatchObject({
      url: "https://example.com",
      formats: ["markdown", { type: "screenshot" }],
      includeTags: ["article", "main"],
      headers: { "X-Test": "1" },
      waitFor: 250,
    });

    expect(
      SearchParamsSchema.parse({
        query: "test",
        limit: "10",
        sources: JSON.stringify(["web"]),
      }),
    ).toMatchObject({
      query: "test",
      limit: 10,
      sources: ["web"],
    });

    expect(
      CrawlParamsSchema.parse({
        url: "https://example.com",
        limit: "250",
        includePaths: JSON.stringify(["^/docs"]),
      }),
    ).toMatchObject({
      url: "https://example.com",
      limit: 250,
      includePaths: ["^/docs"],
    });
  });
});
