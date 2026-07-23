import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfluenceClient } from "../client.js";
import {
  ConfluenceAuthError,
  ConfluenceConflictError,
  ConfluenceNotFoundError,
  ConfluenceRateLimitError,
  ConfluenceServerError,
  ConfluenceValidationError,
} from "../errors.js";

const { pdfGetDocumentMock, mammothExtractRawTextMock } = vi.hoisted(() => ({
  pdfGetDocumentMock: vi.fn(),
  mammothExtractRawTextMock: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfGetDocumentMock,
}));

vi.mock("mammoth", () => ({
  __esModule: true,
  default: {
    extractRawText: mammothExtractRawTextMock,
  },
}));

const baseConfig = {
  subdomain: "mycompany",
  email: "user@example.com",
  apiToken: "token",
  timeoutMs: 12_345,
};

const expectedAuth = `Basic ${Buffer.from("user@example.com:token").toString("base64")}`;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("ConfluenceClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pdfGetDocumentMock.mockReset();
    mammothExtractRawTextMock.mockReset();
  });

  it("sends Basic auth and CQL query string for search", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            content: { id: "100", type: "page" },
            title: "Hello",
            _links: { webui: "/spaces/ENG/pages/100/Hello" },
          },
        ],
        start: 0,
        limit: 25,
        size: 1,
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.search({
      cql: 'type = page AND space = "ENG"',
      limit: 25,
      start: 0,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://mycompany.atlassian.net/wiki/rest/api/search?cql=type+%3D+page+AND+space+%3D+%22ENG%22&limit=25&start=0",
    );
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({
      Authorization: expectedAuth,
      Accept: "application/json",
    });
    expect(Array.isArray(result.results)).toBe(true);
    const first = (result.results as Array<Record<string, unknown>>)[0]!;
    expect(first.webUrl).toBe(
      "https://mycompany.atlassian.net/wiki/spaces/ENG/pages/100/Hello",
    );
  });

  it("derives webUrl on get_page from _links.webui when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: "200",
        title: "Page",
        spaceId: "1",
        _links: { webui: "/spaces/ENG/pages/200/Page" },
        body: { storage: { value: "<p>Hi</p>" } },
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const page = await client.getPage({ pageId: "200" });

    expect(page.webUrl).toBe("https://mycompany.atlassian.net/wiki/spaces/ENG/pages/200/Page");
  });

  it("falls back to viewpage URL when _links.webui missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: "300",
        title: "Page",
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const page = await client.getPage({ pageId: "300" });

    expect(page.webUrl).toBe(
      "https://mycompany.atlassian.net/wiki/pages/viewpage.action?pageId=300",
    );
  });

  it("passes body-format query param", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: "1", _links: { webui: "/x" } }),
    );

    const client = new ConfluenceClient(baseConfig);
    await client.getPage({ pageId: "1", bodyFormat: "atlas_doc_format" });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://mycompany.atlassian.net/wiki/api/v2/pages/1?body-format=atlas_doc_format",
    );
  });

  it("decorates results lists from children, ancestors, labels-by-page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          { id: "10", _links: { webui: "/spaces/ENG/pages/10/A" } },
          { id: "11" },
        ],
        _links: { next: "/api/v2/pages/1/children?cursor=abc" },
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.getPageChildren({ pageId: "1" });
    const results = result.results as Array<Record<string, unknown>>;
    expect(results[0]?.webUrl).toBe("https://mycompany.atlassian.net/wiki/spaces/ENG/pages/10/A");
    expect(results[1]?.webUrl).toBe(
      "https://mycompany.atlassian.net/wiki/pages/viewpage.action?pageId=11",
    );
  });

  it("retries 429 with Retry-After then raises rate-limit error after exhaustion", async () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: TimerHandler) => {
        if (typeof cb === "function") cb();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
    );

    const client = new ConfluenceClient(baseConfig);
    await expect(client.validate()).rejects.toBeInstanceOf(ConfluenceRateLimitError);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    setTimeoutSpy.mockRestore();
  });

  it("retries 5xx then maps to server error", async () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: TimerHandler) => {
        if (typeof cb === "function") cb();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));

    const client = new ConfluenceClient(baseConfig);
    const error = await client.validate().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      responseBody: "{}",
      endpoint: "/api/v2/spaces",
      status: 500,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("{}");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    setTimeoutSpy.mockRestore();
  });

  it.each([
    [401, ConfluenceAuthError],
    [403, ConfluenceAuthError],
    [404, ConfluenceNotFoundError],
    [422, ConfluenceValidationError],
  ])("maps %s to typed error with x-arequestid", async (status, errorClass) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "boom" }), {
        status,
        headers: {
          "content-type": "application/json",
          "x-arequestid": "req-xyz",
        },
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const promise = client.getPage({ pageId: "1" });
    await expect(promise).rejects.toBeInstanceOf(errorClass);
    await promise.catch((error: { requestId?: string }) => {
      expect(error.requestId).toBe("req-xyz");
    });
  });

  it("downloads and extracts a PDF using site-Basic-auth", async () => {
    pdfGetDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [{ str: "hello" }, { str: "world" }],
          }),
        }),
      }),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.downloadAndExtractFile({
      url: "https://mycompany.atlassian.net/wiki/download/attachments/1/a.pdf",
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: expectedAuth,
    });
    expect(result).toMatchObject({
      text: "hello world",
      source: {
        url: "https://mycompany.atlassian.net/wiki/download/attachments/1/a.pdf",
        contentType: "application/pdf",
        bytes: 4,
        authenticated: true,
      },
    });
  });

  it("includes the upstream response body when a file download fails", async () => {
    const url = "https://mycompany.atlassian.net/wiki/download/attachments/1/a.pdf";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    const client = new ConfluenceClient(baseConfig);
    const error = await client.downloadAndExtractFile({ url }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, endpoint: url, responseBody: "upstream unavailable" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("upstream unavailable");
  });

  it("wraps CQL with space filter when confluenceSpace is set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [], start: 0, limit: 25, size: 0 }));

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    await client.search({ cql: 'text ~ "panda" ORDER BY lastmodified DESC' });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get("cql")).toBe(
      '(text ~ "panda") AND space = "ENG" ORDER BY lastmodified DESC',
    );
  });

  it("forces keys filter to scoped space on list_spaces", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ results: [] }));

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    await client.listSpaces({ keys: "OTHER" });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get("keys")).toBe("ENG");
  });

  it("uses space-scoped labels endpoint and pages-by-label space-id when scoped", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/v2/spaces")) {
        return jsonResponse({ results: [{ id: "55", key: "ENG" }] });
      }
      if (url.pathname.endsWith("/api/v2/spaces/55/labels")) {
        return jsonResponse({ results: [{ id: "lbl-1", name: "runbook" }] });
      }
      if (url.pathname.endsWith("/api/v2/labels/lbl-1/pages")) {
        return jsonResponse({ results: [] });
      }
      throw new Error(`unexpected ${url.toString()}`);
    });

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    await client.listLabels({});
    await client.getPagesByLabel({ labelId: "lbl-1" });

    const calls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(calls).toContain(
      "https://mycompany.atlassian.net/wiki/api/v2/spaces?keys=ENG&limit=1",
    );
    expect(calls).toContain("https://mycompany.atlassian.net/wiki/api/v2/spaces/55/labels");
    const pagesCall = calls.find((url) => url.includes("/labels/lbl-1/pages"));
    expect(new URL(pagesCall ?? "").searchParams.get("space-id")).toBe("55");
  });

  it("lists pages by explicit spaceId with repeated status query params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ results: [{ id: "p1", _links: { webui: "/spaces/ENG/pages/p1/A" } }] }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.listSpacePages({
      spaceId: "55",
      depth: "root",
      sort: "-modified-date",
      status: ["current", "archived"],
      bodyFormat: "storage",
      limit: 10,
    });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/wiki/api/v2/spaces/55/pages");
    expect(url.searchParams.getAll("status")).toEqual(["current", "archived"]);
    expect(url.searchParams.get("depth")).toBe("root");
    expect(url.searchParams.get("sort")).toBe("-modified-date");
    expect(url.searchParams.get("body-format")).toBe("storage");
    const results = result.results as Array<Record<string, unknown>>;
    expect(results[0]?.webUrl).toBe("https://mycompany.atlassian.net/wiki/spaces/ENG/pages/p1/A");
  });

  it("resolves spaceId from confluenceSpace for list_space_pages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/v2/spaces")) {
        return jsonResponse({ results: [{ id: "55", key: "ENG" }] });
      }
      if (url.pathname.endsWith("/api/v2/spaces/55/pages")) {
        return jsonResponse({ results: [] });
      }
      throw new Error(`unexpected ${url.toString()}`);
    });

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    await client.listSpacePages({});

    const calls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes("/api/v2/spaces/55/pages"))).toBe(true);
  });

  it("throws when listSpacePages called with no spaceId and no scope", async () => {
    const client = new ConfluenceClient(baseConfig);
    await expect(client.listSpacePages({})).rejects.toBeInstanceOf(ConfluenceValidationError);
  });

  it("creates a page with storage body and decorates the result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: "900", title: "New", _links: { webui: "/spaces/ENG/pages/900/New" } }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.createPage({
      spaceId: "55",
      parentId: "10",
      title: "New",
      body: "<p>Hello</p>",
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://mycompany.atlassian.net/wiki/api/v2/pages");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      spaceId: "55",
      parentId: "10",
      status: "current",
      title: "New",
      body: { representation: "storage", value: "<p>Hello</p>" },
    });
    expect(result.webUrl).toBe("https://mycompany.atlassian.net/wiki/spaces/ENG/pages/900/New");
  });

  it("defaults create_page to scoped space and rejects mismatched explicit spaceId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/v2/spaces")) {
        return jsonResponse({ results: [{ id: "55", key: "ENG" }] });
      }
      if (url.pathname.endsWith("/api/v2/pages")) {
        return jsonResponse({ id: "901" });
      }
      throw new Error(`unexpected ${url.toString()}`);
    });

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    await client.createPage({ title: "Scoped", body: "<p>Hello</p>" });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).spaceId).toBe("55");

    await expect(
      client.createPage({ spaceId: "99", title: "Other", body: "<p>Hello</p>" }),
    ).rejects.toBeInstanceOf(ConfluenceValidationError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("requires spaceId for create_page when unscoped", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ConfluenceClient(baseConfig);
    await expect(client.createPage({ title: "No space", body: "<p>Hello</p>" })).rejects.toBeInstanceOf(
      ConfluenceValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replaces a page by fetching version and preserving current title", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "GET") {
        return jsonResponse({ id: "42", title: "Current", version: { number: 7 } });
      }
      return jsonResponse({ id: "42", title: "Current", version: { number: 8 } });
    });

    const client = new ConfluenceClient(baseConfig);
    await client.replacePage({ pageId: "42", body: "<p>Updated</p>" });

    expect(fetchSpy.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      id: "42",
      status: "current",
      title: "Current",
      body: { representation: "storage", value: "<p>Updated</p>" },
      version: { number: 8 },
    });
  });

  it("uses supplied title on replace_page and maps 409 to conflict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "GET") {
        return jsonResponse({ id: "42", title: "Current", version: { number: 7 } });
      }
      return new Response(JSON.stringify({ message: "version conflict" }), { status: 409 });
    });

    const client = new ConfluenceClient(baseConfig);
    await expect(
      client.replacePage({ pageId: "42", title: "Renamed", body: "<p>Updated</p>" }),
    ).rejects.toBeInstanceOf(ConfluenceConflictError);
  });

  it("returns scopedSpace metadata from validate when scoped", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ results: [{ id: "55", key: "ENG", name: "Engineering" }] }),
    );

    const client = new ConfluenceClient({ ...baseConfig, confluenceSpace: "ENG" });
    const result = await client.validate();

    expect(result).toMatchObject({ ok: true, scopedSpace: { key: "ENG", id: "55" } });
  });

  it("downloads a DOCX without auth when URL is off-site", async () => {
    mammothExtractRawTextMock.mockResolvedValue({ value: "doc text" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );

    const client = new ConfluenceClient(baseConfig);
    const result = await client.downloadAndExtractFile({
      url: "https://cdn.example.com/a.docx",
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({});
    expect(result).toMatchObject({
      text: "doc text",
      source: { authenticated: false },
    });
  });
});
