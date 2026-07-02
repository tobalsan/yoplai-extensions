import { describe, expect, it } from "vitest";

import {
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
