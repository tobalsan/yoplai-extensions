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

describe("Notion extension request handling", () => {
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

  it("lists and searches pages through Notion search", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
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
      notionVersion: "2026-03-11",
      timeoutMs: 12_345,
    });

    await client.listPages(undefined, 50, "cursor-1");
    await client.searchPages("roadmap", 10);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.notion.com/v1/search",
      "https://api.notion.com/v1/search",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        filter: { property: "object", value: "page" },
        page_size: 50,
        start_cursor: "cursor-1",
      }),
    );
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        query: "roadmap",
        filter: { property: "object", value: "page" },
        page_size: 10,
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

  it("replaces matching direct child heading sections after appending new blocks", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "intro",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Keep" }] },
              },
              {
                object: "block",
                id: "summary-heading",
                type: "heading_3",
                heading_3: { rich_text: [{ plain_text: " resume summary " }] },
              },
              {
                object: "block",
                id: "summary-bullet",
                type: "bulleted_list_item",
                bulleted_list_item: { rich_text: [{ plain_text: "Old summary" }] },
              },
            ],
            next_cursor: "cursor-2",
            has_more: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "assessment-heading",
                type: "heading_2",
                heading_2: { rich_text: [{ text: { content: "AI Assessment" } }] },
              },
              {
                object: "block",
                id: "assessment-bullet",
                type: "bulleted_list_item",
                bulleted_list_item: { rich_text: [{ plain_text: "Old assessment" }] },
              },
              {
                object: "block",
                id: "other-heading",
                type: "heading_3",
                heading_3: { rich_text: [{ plain_text: "Other" }] },
              },
              {
                object: "block",
                id: "other-body",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Keep" }] },
              },
            ],
            next_cursor: null,
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "list", results: [{ id: "new-block" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementation(async () => new Response(JSON.stringify({ object: "block" }), { status: 200 }));

    const client = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(
      client.replaceChildBlocks({
        blockId: "page-123",
        headingTexts: ["Resume Summary", "AI Assessment"],
        children: [
          {
            type: "heading_3",
            heading_3: { richText: [{ text: "Resume Summary" }] },
          },
        ],
        pageSize: 3,
      }),
    ).resolves.toEqual({
      object: "replace_child_blocks_result",
      blockId: "page-123",
      matchedHeadingTexts: ["resume summary", "AI Assessment"],
      deletedBlockCount: 4,
      appendedBlockCount: 1,
      deletedBlockIds: ["summary-heading", "summary-bullet", "assessment-heading", "assessment-bullet"],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://api.notion.com/v1/blocks/page-123/children?page_size=3",
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://api.notion.com/v1/blocks/page-123/children?page_size=3&start_cursor=cursor-2",
    );
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("https://api.notion.com/v1/blocks/page-123/children");
    expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(fetchSpy.mock.calls.slice(3).map((call) => call[0])).toEqual([
      "https://api.notion.com/v1/blocks/summary-heading",
      "https://api.notion.com/v1/blocks/summary-bullet",
      "https://api.notion.com/v1/blocks/assessment-heading",
      "https://api.notion.com/v1/blocks/assessment-bullet",
    ]);
    expect(fetchSpy.mock.calls.slice(3).map((call) => call[1]?.method)).toEqual([
      "DELETE",
      "DELETE",
      "DELETE",
      "DELETE",
    ]);
  });

  it("appends without deleting when no child headings match", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "other-heading",
                type: "heading_3",
                heading_3: { rich_text: [{ plain_text: "Other" }] },
              },
            ],
            next_cursor: null,
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "list", results: [{ id: "new-block" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = new NotionClient({
      apiKey: "secret",
      notionVersion: "2025-09-03",
      timeoutMs: 12_345,
    });

    await expect(
      client.replaceChildBlocks({
        blockId: "page-123",
        headingTexts: ["Resume Summary"],
        children: [{ type: "paragraph", paragraph: { richText: ["New"] } }],
      }),
    ).resolves.toMatchObject({
      deletedBlockCount: 0,
      appendedBlockCount: 1,
      deletedBlockIds: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PATCH");
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
