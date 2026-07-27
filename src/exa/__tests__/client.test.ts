import { afterEach, describe, expect, it, vi } from "vitest";

import { ExaClient } from "../client.js";
import {
  ExaAuthError,
  ExaNotFoundError,
  ExaRateLimitError,
  ExaServerError,
  ExaValidationError,
} from "../errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient(): ExaClient {
  return new ExaClient({ apiKey: "secret" });
}

describe("Exa extension request handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Exa headers and search payload with defaults", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ requestId: "req-1", results: [] }));

    await createClient().search({ query: "exa api" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.exa.ai/search");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": "secret",
        "x-exa-integration": "exa-cli",
      },
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: "exa api",
        numResults: 8,
        type: "auto",
        livecrawl: "fallback",
        contents: { maxCharacters: 10_000 },
      }),
    );
  });

  it("sends explicit search options", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [] }));

    await createClient().search({
      query: "exa api",
      numResults: 3,
      type: "fast",
      livecrawl: "preferred",
      maxCharacters: 2000,
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: "exa api",
        numResults: 3,
        type: "fast",
        livecrawl: "preferred",
        contents: { maxCharacters: 2000 },
      }),
    );
  });

  it("sends code context requests to /context", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ context: "..." }));

    await createClient().code({ query: "zod transform" });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.exa.ai/context");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ query: "zod transform", tokens: 5000 }),
    );
  });

  it.each([[999], [50_001]])("rejects out-of-range code tokens (%s) without a request", async (tokens) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(createClient().code({ query: "zod", tokens })).rejects.toBeInstanceOf(
      ExaValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends deep search with hardcoded deep type and no livecrawl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [] }));

    await createClient().deepSearch({ query: "state of LLM agents" });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.exa.ai/search");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: "state of LLM agents",
        numResults: 8,
        type: "deep",
        contents: { maxCharacters: 10_000 },
      }),
    );
  });

  it("crawls a URL through /contents with always livecrawl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [] }));

    await createClient().crawl({ url: "https://example.com/post" });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.exa.ai/contents");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        ids: ["https://example.com/post"],
        livecrawl: "always",
        text: { maxCharacters: 3000 },
      }),
    );
  });

  it("searches companies with the curated domain list", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [] }));

    await createClient().company({ company: "Anthropic" });

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: "Anthropic",
        numResults: 5,
        type: "auto",
        contents: { maxCharacters: 10_000 },
        includeDomains: [
          "bloomberg.com",
          "reuters.com",
          "crunchbase.com",
          "sec.gov",
          "linkedin.com",
          "forbes.com",
          "businesswire.com",
          "prnewswire.com",
        ],
      }),
    );
  });

  it.each([
    ["profiles", "Jane Doe site:linkedin.com/in"],
    ["companies", "Jane Doe site:linkedin.com/company"],
    ["all", "Jane Doe"],
  ] as const)("builds the linkedin query for type %s", async (type, expectedQuery) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [] }));

    await createClient().linkedin({ query: "Jane Doe", type });

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        query: expectedQuery,
        numResults: 5,
        type: "auto",
        contents: { maxCharacters: 10_000 },
        includeDomains: ["linkedin.com"],
      }),
    );
  });

  it("starts and checks research tasks", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ id: "task-1", status: "running", model: "exa-research" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "task-1", status: "completed", data: { report: "done" } }),
      );

    const client = createClient();

    await expect(client.researchStart({ instructions: "Compare vector DBs" })).resolves.toEqual({
      id: "task-1",
      status: "running",
      model: "exa-research",
    });
    await expect(client.researchCheck({ taskId: "task-1" })).resolves.toEqual({
      id: "task-1",
      status: "completed",
      data: { report: "done" },
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.exa.ai/research/v0/tasks");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ instructions: "Compare vector DBs", model: "exa-research" }),
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe("https://api.exa.ai/research/v0/tasks/task-1");
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("rejects a malformed research task response without an id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ status: "running", model: "exa-research" }),
    );

    await expect(
      createClient().researchStart({ instructions: "Compare vector DBs" }),
    ).rejects.toBeInstanceOf(ExaValidationError);
  });

  it.each([
    [401, ExaAuthError],
    [403, ExaAuthError],
    [404, ExaNotFoundError],
    [400, ExaValidationError],
    [422, ExaValidationError],
  ])("maps %s to an Exa error class", async (status, errorClass) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "boom" }, status),
    );

    await expect(createClient().search({ query: "exa" })).rejects.toBeInstanceOf(errorClass);
  });

  it("surfaces the API error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "invalid query" }, 400),
    );

    await expect(createClient().search({ query: "exa" })).rejects.toThrow("invalid query");
  });

  it("retries 429s and maps 5xx to retryable errors", async () => {
    const immediateTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    const sleepSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "0" } }));

    await expect(createClient().search({ query: "exa" })).rejects.toBeInstanceOf(ExaRateLimitError);
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 500 }));

    await expect(createClient().search({ query: "exa" })).rejects.toBeInstanceOf(ExaServerError);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    sleepSpy.mockRestore();
  });
});
