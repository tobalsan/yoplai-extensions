import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { FirecrawlConfigSchema } from "../models.js";
import { FirecrawlAuthError } from "../errors.js";

describe("firecrawl extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("firecrawl");
    expect(extension.displayName).toBe("Firecrawl");
    expect(extension.description).toContain("Firecrawl");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
    expect(extension.systemPrompt).toContain("firecrawl_monitor");
  });

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

  function createTools() {
    return extension.createTools({
      global: {},
      agent: {},
      merged: {
        apiKey: "fc-secret",
      },
    });
  }

  it("creates the expected tools with object parameter schemas", () => {
    const tools = createTools();

    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => tool.name)).toEqual([
      "scrape",
      "search",
      "map",
      "crawl",
      "monitor",
      "validate",
      "crawl_cancel",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("validates params inside execute and calls the client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, id: "job-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createTools();
    const crawl = tools.find((tool) => tool.name === "crawl");
    const result = (await crawl?.execute({ url: "https://example.com" })) as Record<
      string,
      unknown
    >;

    expect(result.id).toBe("job-123");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://example.com",
      limit: 100,
    });

    await expect(crawl?.execute({ url: "https://example.com", extra: true })).rejects.toThrow();
  });

  describe("validate tool", () => {
    it("returns { ok: true } when API returns 404 (no such job = API is reachable)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

      const tools = createTools();
      const validate = tools.find((tool) => tool.name === "validate");
      const result = await validate?.execute({});
      expect(result).toEqual({ ok: true });
    });

    it("throws FirecrawlAuthError when API returns 401", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );

      const tools = createTools();
      const validate = tools.find((tool) => tool.name === "validate");
      await expect(validate?.execute({})).rejects.toThrow(FirecrawlAuthError);
    });
  });

  describe("crawl_cancel tool", () => {
    it("calls DELETE with the correct URL and returns the response", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const tools = createTools();
      const crawlCancel = tools.find((tool) => tool.name === "crawl_cancel");
      const result = await crawlCancel?.execute({ jobId: "job-abc" });

      expect(result).toEqual({ success: true });
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("/crawl/job-abc");
      expect(init?.method).toBe("DELETE");
    });
  });
});
