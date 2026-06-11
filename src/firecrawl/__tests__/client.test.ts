import { afterEach, describe, expect, it, vi } from "vitest";

import { FirecrawlClient } from "../client.js";
import {
  FirecrawlAuthError,
  FirecrawlNotFoundError,
  FirecrawlServerError,
  FirecrawlValidationError,
} from "../errors.js";

function createClient(): FirecrawlClient {
  return new FirecrawlClient({ apiKey: "fc-secret", timeoutMs: 12_345 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Firecrawl extension request handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends auth headers and a compact scrape payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, data: { markdown: "# Hi" } }),
    );

    const client = createClient();
    await client.scrape({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      country: "FR",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer fc-secret",
        "Content-Type": "application/json",
      },
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        url: "https://example.com",
        formats: ["markdown"],
        onlyMainContent: true,
        location: { country: "FR" },
      }),
    );
  });

  it("forwards parsers and languages in the scrape payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, data: { markdown: "# Hi" } }),
    );

    const client = createClient();
    await client.scrape({
      url: "https://example.com",
      country: "FR",
      languages: ["fr", "en"],
      parsers: [{ type: "pdf", parsePDF: "auto" }],
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        url: "https://example.com",
        location: { country: "FR", languages: ["fr", "en"] },
        parsers: [{ type: "pdf", parsePDF: "auto" }],
      }),
    );
  });

  it("extends the client-side abort timeout when the request timeout is larger", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ success: true, data: { markdown: "# Hi" } }),
    );

    const client = createClient();
    await client.scrape({ url: "https://example.com", timeout: 120_000 });
    expect(timeoutSpy).toHaveBeenLastCalledWith(125_000);

    await client.scrape({ url: "https://example.com" });
    expect(timeoutSpy).toHaveBeenLastCalledWith(12_345);
  });

  it("maps search scrapeFormats to scrapeOptions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, data: { web: [] } }),
    );

    const client = createClient();
    await client.search({ query: "firecrawl", limit: 5, scrapeFormats: ["markdown"] });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/search");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: "firecrawl",
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      }),
    );
  });

  it("posts map requests with sitemap mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, links: [] }),
    );

    const client = createClient();
    await client.map({ url: "https://example.com", limit: 50, sitemap: "only" });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/map");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        url: "https://example.com",
        limit: 50,
        sitemap: "only",
      }),
    );
  });

  it("starts a crawl and returns the job id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        id: "job-123",
        url: "https://api.firecrawl.dev/v2/crawl/job-123",
      }),
    );

    const client = createClient();
    const result = await client.crawl({
      url: "https://example.com",
      limit: 100,
      scrapeFormats: ["markdown"],
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/crawl");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        url: "https://example.com",
        limit: 100,
        scrapeOptions: { formats: ["markdown"] },
      }),
    );
    expect(result.id).toBe("job-123");
  });

  it("forwards webhook and merges scrapeOptions over scrapeFormats in crawl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, id: "job-456" }),
    );

    const client = createClient();
    await client.crawl({
      url: "https://example.com",
      limit: 100,
      scrapeFormats: ["markdown"],
      scrapeOptions: { onlyMainContent: false, maxAge: 0 },
      webhook: { url: "https://hooks.example.com/fc", events: ["completed"] },
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        url: "https://example.com",
        limit: 100,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: false, maxAge: 0 },
        webhook: { url: "https://hooks.example.com/fc", events: ["completed"] },
      }),
    );
  });

  it("monitors a crawl job and follows pagination", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          status: "completed",
          total: 2,
          completed: 2,
          next: "https://api.firecrawl.dev/v2/crawl/job-123?skip=1",
          data: [{ markdown: "page 1" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "completed",
          total: 2,
          completed: 2,
          data: [{ markdown: "page 2" }],
        }),
      );

    const client = createClient();
    const result = await client.getCrawlStatus({ jobId: "job-123", autoPaginate: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.firecrawl.dev/v2/crawl/job-123");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://api.firecrawl.dev/v2/crawl/job-123?skip=1",
    );
    expect(result.data).toEqual([{ markdown: "page 1" }, { markdown: "page 2" }]);
    expect(result.next).toBeNull();
  });

  it("does not follow pagination when autoPaginate is false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        status: "scraping",
        next: "https://api.firecrawl.dev/v2/crawl/job-123?skip=10",
        data: [{ markdown: "page 1" }],
      }),
    );

    const client = createClient();
    const result = await client.getCrawlStatus({ jobId: "job-123", autoPaginate: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.next).toBe("https://api.firecrawl.dev/v2/crawl/job-123?skip=10");
  });

  it.each([
    [401, FirecrawlAuthError],
    [403, FirecrawlAuthError],
    [404, FirecrawlNotFoundError],
    [422, FirecrawlValidationError],
  ])("maps %s to a Firecrawl error class", async (status, errorClass) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: false, error: "request failed" }, status),
    );

    const client = createClient();
    await expect(client.scrape({ url: "https://example.com" })).rejects.toBeInstanceOf(errorClass);
  });

  it("retries server errors before failing", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "boom" }, 500))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { markdown: "# Hi" } }));

    const client = createClient();
    const result = await client.scrape({ url: "https://example.com" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, data: { markdown: "# Hi" } });
  });

  it("throws a server error after exhausting retries", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: false, error: "boom" }, 500),
    );

    const client = createClient();
    await expect(client.scrape({ url: "https://example.com" })).rejects.toBeInstanceOf(
      FirecrawlServerError,
    );
  });
});
