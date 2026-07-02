import { describe, expect, it } from "vitest";

import {
  DownloadFileParamsSchema,
  DownloadFileResultSchema,
  FileSchema,
  ListDealFilesParamsSchema,
  ListDealsParamsSchema,
  PipedriveConfigSchema,
} from "../models.js";

describe("PipedriveConfigSchema", () => {
  it("accepts a valid config", () => {
    const parsed = PipedriveConfigSchema.parse({ apiToken: "tok", domain: "acme" });
    expect(parsed).toEqual({ apiToken: "tok", domain: "acme" });
  });

  it("rejects a missing/empty token with a clear error", () => {
    const result = PipedriveConfigSchema.safeParse({ apiToken: "", domain: "acme" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("PIPEDRIVE_API_TOKEN is required");
    }
  });

  it("rejects a missing domain", () => {
    const result = PipedriveConfigSchema.safeParse({ apiToken: "tok" });
    expect(result.success).toBe(false);
  });
});

describe("ListDealsParamsSchema", () => {
  it("accepts an empty params object (all filters optional)", () => {
    expect(ListDealsParamsSchema.parse({})).toEqual({});
  });

  it("coerces stringified integer ids to numbers", () => {
    const parsed = ListDealsParamsSchema.parse({ pipeline_id: "2", limit: "50" });
    expect(parsed.pipeline_id).toBe(2);
    expect(parsed.limit).toBe(50);
  });

  it("rejects a non-integer id", () => {
    expect(ListDealsParamsSchema.safeParse({ pipeline_id: "abc" }).success).toBe(false);
  });

  it("validates the close-date range format", () => {
    expect(
      ListDealsParamsSchema.safeParse({ expected_close_from: "2025-07-01" }).success,
    ).toBe(true);
    expect(
      ListDealsParamsSchema.safeParse({ expected_close_from: "07/01/2025" }).success,
    ).toBe(false);
  });

  it("rejects an unknown status value", () => {
    expect(ListDealsParamsSchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(ListDealsParamsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("File entity + deal-file schemas", () => {
  it("accepts a valid file entity with nullable metadata", () => {
    const parsed = FileSchema.parse({
      id: 1,
      name: "sale.xlsx",
      type: "xlsx",
      size: 100,
      deal_id: 42,
      add_time: null,
      url: null,
    });
    expect(parsed.name).toBe("sale.xlsx");
    expect(parsed.type).toBe("xlsx");
  });

  it("requires deal_id for list_deal_files and coerces strings", () => {
    expect(ListDealFilesParamsSchema.parse({ deal_id: "42" }).deal_id).toBe(42);
    expect(ListDealFilesParamsSchema.safeParse({}).success).toBe(false);
    expect(ListDealFilesParamsSchema.safeParse({ deal_id: 1, extra: 2 }).success).toBe(false);
  });

  it("requires file_id for download_file", () => {
    expect(DownloadFileParamsSchema.parse({ file_id: "100" }).file_id).toBe(100);
    expect(DownloadFileParamsSchema.safeParse({}).success).toBe(false);
  });

  it("pins the download result encoding to base64", () => {
    const parsed = DownloadFileResultSchema.parse({
      file_id: 1,
      name: null,
      mime_type: null,
      size: 3,
      encoding: "base64",
      content_base64: "AAAA",
    });
    expect(parsed.encoding).toBe("base64");
    expect(DownloadFileResultSchema.safeParse({
      file_id: 1,
      name: null,
      mime_type: null,
      size: 3,
      encoding: "hex",
      content_base64: "AAAA",
    }).success).toBe(false);
  });
});
