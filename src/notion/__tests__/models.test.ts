import { describe, expect, it } from "vitest";
import {
  AppendBlocksParamsSchema,
  DeleteBlockParamsSchema,
  DownloadAndExtractFileParamsSchema,
  GetBlocksParamsSchema,
  GetDataSourceParamsSchema,
  GetPageParamsSchema,
  ListDataSourcesParamsSchema,
  ListPagesParamsSchema,
  NotionConfigSchema,
  QueryDataSourceParamsSchema,
  SearchPagesParamsSchema,
  ReplaceChildBlocksParamsSchema,
  UpdateDataSourceParamsSchema,
  UpdatePagePropertiesParamsSchema,
  ValidateParamsSchema,
} from "../models.js";

describe("notion models", () => {
  it("parses config defaults", () => {
    expect(
      NotionConfigSchema.parse({
        apiKey: "secret",
      }),
    ).toEqual({
      apiKey: "secret",
      notionVersion: "2026-03-11",
      timeoutMs: 30_000,
    });
  });

  it("parses tool parameter schemas", () => {
    expect(
      ListDataSourcesParamsSchema.parse({
        query: "applications",
        pageSize: 25,
        startCursor: "cursor-1",
      }),
    ).toEqual({
      query: "applications",
      pageSize: 25,
      startCursor: "cursor-1",
    });
    expect(
      ListPagesParamsSchema.parse({
        query: "release notes",
        pageSize: "10",
        startCursor: "cursor-1",
      }),
    ).toEqual({
      query: "release notes",
      pageSize: 10,
      startCursor: "cursor-1",
    });
    expect(
      SearchPagesParamsSchema.parse({
        query: "roadmap",
        pageSize: 10,
      }),
    ).toEqual({
      query: "roadmap",
      pageSize: 10,
    });
    expect(GetDataSourceParamsSchema.parse({ dataSourceId: "db-123" })).toEqual({
      dataSourceId: "db-123",
    });
    expect(
      UpdateDataSourceParamsSchema.parse({
        dataSourceId: "db-123",
        title: [{ plain_text: "Applications" }],
        properties: {
          "AI Note": {
            richText: [],
          },
        },
      }),
    ).toMatchObject({
      dataSourceId: "db-123",
      title: [{ plain_text: "Applications" }],
    });
    expect(
      QueryDataSourceParamsSchema.parse({
        dataSourceId: "db-123",
        filter: { property: "Stage", select: { equals: "New" } },
        sorts: [{ property: "Created time", direction: "descending" }],
        pageSize: 25,
        startCursor: "cursor-1",
      }),
    ).toMatchObject({
      dataSourceId: "db-123",
      pageSize: 25,
      startCursor: "cursor-1",
    });
    expect(GetPageParamsSchema.parse({ pageId: "page-123" })).toEqual({
      pageId: "page-123",
    });
    expect(
      UpdatePagePropertiesParamsSchema.parse({
        pageId: "page-123",
        properties: {
          "AI Note": {
            richText: [{ text: { content: "Needs review" } }],
          },
        },
      }),
    ).toMatchObject({
      pageId: "page-123",
    });
    expect(GetBlocksParamsSchema.parse({ blockId: "page-123", pageSize: 100 })).toEqual({
      blockId: "page-123",
      pageSize: 100,
    });
    expect(
      AppendBlocksParamsSchema.parse({
        blockId: "page-123",
        children: [{ object: "block", type: "paragraph" }],
      }),
    ).toEqual({
      blockId: "page-123",
      children: [{ object: "block", type: "paragraph" }],
    });
    expect(DeleteBlockParamsSchema.parse({ blockId: "block-123" })).toEqual({
      blockId: "block-123",
    });
    expect(
      ReplaceChildBlocksParamsSchema.parse({
        blockId: "page-123",
        headingTexts: ["Resume Summary"],
        headingTypes: ["heading_3"],
        children: [{ object: "block", type: "paragraph" }],
        pageSize: 100,
      }),
    ).toEqual({
      blockId: "page-123",
      headingTexts: ["Resume Summary"],
      headingTypes: ["heading_3"],
      children: [{ object: "block", type: "paragraph" }],
      pageSize: 100,
    });
    expect(
      DownloadAndExtractFileParamsSchema.parse({
        url: "https://example.com/resume.pdf",
        filename: "resume.pdf",
        contentType: "application/pdf",
      }),
    ).toEqual({
      url: "https://example.com/resume.pdf",
      filename: "resume.pdf",
      contentType: "application/pdf",
    });
    expect(ValidateParamsSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys on strict schemas", () => {
    expect(() => ListPagesParamsSchema.parse({ extra: true })).toThrow();
    expect(() => SearchPagesParamsSchema.parse({ query: "", extra: true })).toThrow();
    expect(() => GetPageParamsSchema.parse({ pageId: "page-123", extra: true })).toThrow();
    expect(() =>
      ValidateParamsSchema.parse({
        extra: true,
      }),
    ).toThrow();
  });

  it("accepts JSON-encoded nested tool arguments", () => {
    expect(
      QueryDataSourceParamsSchema.parse({
        dataSourceId: "db-123",
        filter: JSON.stringify({
          property: "AI Tags",
          multi_select: { is_empty: true },
        }),
        sorts: JSON.stringify([{ property: "Created time", direction: "descending" }]),
        pageSize: "100",
      }),
    ).toMatchObject({
      dataSourceId: "db-123",
      pageSize: 100,
      filter: {
        property: "AI Tags",
        multi_select: { is_empty: true },
      },
      sorts: [{ property: "Created time", direction: "descending" }],
    });

    expect(
      UpdatePagePropertiesParamsSchema.parse({
        pageId: "page-123",
        properties: JSON.stringify({
          "AI Tags": { multi_select: [{ name: "hot" }] },
          "AI Note": {
            rich_text: [{ text: { content: "Strong fit." } }],
          },
        }),
      }),
    ).toMatchObject({
      pageId: "page-123",
      properties: {
        "AI Tags": { multi_select: [{ name: "hot" }] },
        "AI Note": {
          rich_text: [{ text: { content: "Strong fit." } }],
        },
      },
    });

    expect(
      AppendBlocksParamsSchema.parse({
        blockId: "page-123",
        children: JSON.stringify([{ object: "block", type: "paragraph" }]),
      }),
    ).toEqual({
      blockId: "page-123",
      children: [{ object: "block", type: "paragraph" }],
    });

    expect(
      ReplaceChildBlocksParamsSchema.parse({
        blockId: "page-123",
        headingTexts: ["AI Assessment"],
        headingTypes: JSON.stringify(["heading_2"]),
        children: JSON.stringify([{ object: "block", type: "paragraph" }]),
        pageSize: "100",
      }),
    ).toEqual({
      blockId: "page-123",
      headingTexts: ["AI Assessment"],
      headingTypes: ["heading_2"],
      children: [{ object: "block", type: "paragraph" }],
      pageSize: 100,
    });

    expect(
      ReplaceChildBlocksParamsSchema.parse({
        blockId: "page-123",
        headingTexts: JSON.stringify(["Resume Summary", "AI Summary", "AI Assessment"]),
        children: JSON.stringify([{ object: "block", type: "paragraph" }]),
      }),
    ).toMatchObject({
      headingTexts: ["Resume Summary", "AI Summary", "AI Assessment"],
    });
  });
});
