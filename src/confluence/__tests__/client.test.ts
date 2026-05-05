import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfluenceClient } from "../client.js";
import {
  ConfluenceAuthError,
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
    await expect(client.validate()).rejects.toBeInstanceOf(ConfluenceServerError);
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
