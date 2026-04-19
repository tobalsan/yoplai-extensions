import { afterEach, describe, expect, it, vi } from "vitest";

import { NotionClient } from "../client.js";
import {
  NotionAuthError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionServerError,
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

describe("Notion connector request handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pdfGetDocumentMock.mockReset();
    mammothExtractRawTextMock.mockReset();
  });

  it("sends auth, version, and Notion-shaped query payloads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [],
          next_cursor: null,
          has_more: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await client.queryDataSource({
      dataSourceId: "db-123",
      filter: {
        property: "Stage",
        select: { equals: "New" },
      },
      sorts: [{ property: "Created time", direction: "descending" }],
      pageSize: 25,
      startCursor: "cursor-1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.notion.com/v1/data_sources/db-123/query");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer secret",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        filter: {
          property: "Stage",
          select: { equals: "New" },
        },
        sorts: [{ property: "Created time", direction: "descending" }],
        page_size: 25,
        start_cursor: "cursor-1",
      }),
    );
  });

  it("patches data sources and pages with snake-cased bodies", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "data_source",
            id: "db-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "page",
            id: "page-123",
            properties: {
              "AI Note": { id: "note-id", type: "rich_text" },
              "AI Tags": { id: "tags-id", type: "multi_select" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "page",
            id: "page-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const client = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await client.updateDataSource({
      dataSourceId: "db-123",
      title: [{ plainText: "Applications" }],
      description: [{ plainText: "Hiring" }],
      properties: {
        "AI Note": { richText: [] },
        "AI Tags": {
          multiSelect: {
            options: [{ name: "hot" }],
          },
        },
      },
    });

    await client.updatePageProperties({
      pageId: "page-123",
      properties: {
        "note-id": {
          richText: [{ text: "Needs review" }],
        },
        "tags-id": {
          multiSelect: [{ name: "review" }],
        },
      },
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.notion.com/v1/data_sources/db-123");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        title: [{ plain_text: "Applications" }],
        description: [{ plain_text: "Hiring" }],
        properties: {
          "AI Note": { rich_text: [] },
          "AI Tags": {
            multi_select: {
              options: [{ name: "hot" }],
            },
          },
        },
      }),
    );

    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://api.notion.com/v1/pages/page-123");
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("https://api.notion.com/v1/pages/page-123");
    expect(fetchSpy.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        properties: {
          "AI Note": {
            rich_text: [{ text: { content: "Needs review" }, type: "text" }],
          },
          "AI Tags": {
            multi_select: [{ name: "review" }],
          },
        },
      }),
    );
  });

  it.each([
    [401, NotionAuthError],
    [403, NotionAuthError],
    [404, NotionNotFoundError],
  ])("maps %s to a Notion error class", async (status, errorClass) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ object: "error", code: "failed" }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(client.getDataSource("db-123")).rejects.toBeInstanceOf(errorClass);
  });

  it("retries 429s and maps 5xx to retryable errors", async () => {
    const immediateTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    const sleepSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout);

    const rateLimitFetch = vi.spyOn(globalThis, "fetch");
    rateLimitFetch
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }));

    const rateLimitClient = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(rateLimitClient.getDataSource("db-429")).rejects.toBeInstanceOf(NotionRateLimitError);
    expect(rateLimitFetch).toHaveBeenCalledTimes(4);

    rateLimitFetch.mockReset();
    rateLimitFetch
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));

    const serverErrorClient = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(serverErrorClient.getDataSource("db-500")).rejects.toBeInstanceOf(NotionServerError);
    expect(rateLimitFetch).toHaveBeenCalledTimes(4);
    sleepSpy.mockRestore();
  });

  it("downloads and extracts PDF and DOCX files", async () => {
    pdfGetDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [{ str: "PDF resume text" }],
          }),
        }),
      }),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const pdfClient = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(
      pdfClient.downloadAndExtractFile({
        url: "https://example.com/resume.pdf",
      }),
    ).resolves.toMatchObject({
      text: "PDF resume text",
      source: {
        url: "https://example.com/resume.pdf",
        filename: null,
        contentType: "application/pdf",
        bytes: 4,
      },
    });

    mammothExtractRawTextMock.mockResolvedValue({ value: "DOCX resume text" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );

    const docxClient = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(
      docxClient.downloadAndExtractFile({
        url: "https://example.com/resume.docx",
      }),
    ).resolves.toMatchObject({
      text: "DOCX resume text",
      source: {
        url: "https://example.com/resume.docx",
        filename: null,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: 4,
      },
    });
  });
});
