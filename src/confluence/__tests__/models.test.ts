import { describe, expect, it } from "vitest";

import {
  ConfluenceConfigSchema,
  DownloadAndExtractFileParamsSchema,
  GetPageAncestorsParamsSchema,
  GetPageChildrenParamsSchema,
  GetPageParamsSchema,
  GetPagesByLabelParamsSchema,
  ListAttachmentsParamsSchema,
  ListLabelsParamsSchema,
  SearchParamsSchema,
  ValidateParamsSchema,
} from "../models.js";

describe("confluence models", () => {
  it("parses config defaults and rejects malformed input", () => {
    expect(
      ConfluenceConfigSchema.parse({
        subdomain: "mycompany",
        email: "user@example.com",
        apiToken: "token",
      }),
    ).toEqual({
      subdomain: "mycompany",
      email: "user@example.com",
      apiToken: "token",
      timeoutMs: 30_000,
    });

    expect(() =>
      ConfluenceConfigSchema.parse({
        subdomain: "",
        email: "user@example.com",
        apiToken: "token",
      }),
    ).toThrow();

    expect(() =>
      ConfluenceConfigSchema.parse({
        subdomain: "mycompany",
        email: "not-an-email",
        apiToken: "token",
      }),
    ).toThrow();
  });

  it("parses tool parameter schemas", () => {
    expect(
      SearchParamsSchema.parse({
        cql: 'type = page AND space = "ENG"',
        limit: 10,
        start: 0,
      }),
    ).toEqual({
      cql: 'type = page AND space = "ENG"',
      limit: 10,
      start: 0,
    });

    expect(
      GetPageParamsSchema.parse({
        pageId: "12345",
        bodyFormat: "atlas_doc_format",
      }),
    ).toEqual({
      pageId: "12345",
      bodyFormat: "atlas_doc_format",
    });

    expect(GetPageChildrenParamsSchema.parse({ pageId: "1", limit: "20", cursor: "c1" })).toEqual({
      pageId: "1",
      limit: 20,
      cursor: "c1",
    });

    expect(GetPageAncestorsParamsSchema.parse({ pageId: "1" })).toEqual({ pageId: "1" });
    expect(ListAttachmentsParamsSchema.parse({ pageId: "1" })).toEqual({ pageId: "1" });
    expect(
      DownloadAndExtractFileParamsSchema.parse({
        url: "https://x.atlassian.net/wiki/download/attachments/1/a.pdf",
        filename: "a.pdf",
        contentType: "application/pdf",
      }),
    ).toEqual({
      url: "https://x.atlassian.net/wiki/download/attachments/1/a.pdf",
      filename: "a.pdf",
      contentType: "application/pdf",
    });
    expect(ListLabelsParamsSchema.parse({})).toEqual({});
    expect(GetPagesByLabelParamsSchema.parse({ labelId: "lbl-1" })).toEqual({ labelId: "lbl-1" });
    expect(ValidateParamsSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys on strict schemas and bad enums", () => {
    expect(() => GetPageParamsSchema.parse({ pageId: "1", extra: true })).toThrow();
    expect(() => GetPageParamsSchema.parse({ pageId: "1", bodyFormat: "wiki" })).toThrow();
    expect(() => SearchParamsSchema.parse({ cql: "" })).toThrow();
    expect(() => ValidateParamsSchema.parse({ extra: true })).toThrow();
  });
});
