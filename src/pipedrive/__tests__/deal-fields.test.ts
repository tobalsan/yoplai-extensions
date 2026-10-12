import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipedriveClient, flattenCustomFields } from "../client.js";
import { PipedriveNotFoundError } from "../errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dealFieldsPage(
  fields: unknown[],
  pagination: Record<string, unknown>,
): Record<string, unknown> {
  return { success: true, data: fields, additional_data: { pagination } };
}

describe("flattenCustomFields", () => {
  it("merges top-level hash keys and nested v2 custom_fields, dropping standard keys", () => {
    const flat = flattenCustomFields({
      id: 1,
      title: "Deal",
      value: 100,
      hash_top: "a",
      custom_fields: { hash_nested: "b" },
    });
    expect(flat).toEqual({ hash_top: "a", hash_nested: "b" });
    expect(flat).not.toHaveProperty("id");
    expect(flat).not.toHaveProperty("custom_fields");
  });
});

describe("PipedriveClient deal-field endpoints", () => {
  let dir: string;
  let cachePath: string;

  function createClient(): PipedriveClient {
    return new PipedriveClient({
      apiToken: "secret",
      domain: "acme",
      timeoutMs: 1_000,
      registryOptions: { cachePath },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pd-deal-"));
    cachePath = path.join(dir, "registry.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("list_deal_fields targets v1 dealFields with offset pagination params", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          dealFieldsPage(
            [{ id: 2, key: "ffk9s9", name: "Contract Value", field_type: "monetary" }],
            { start: 0, limit: 100, more_items_in_collection: false, next_start: null },
          ),
        ),
      );

    const result = await createClient().listDealFields({ start: 0, limit: 100 });

    const url = new URL(String((spy.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe("/api/v1/dealFields");
    expect(url.searchParams.get("start")).toBe("0");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(result.fields[0].field_type).toBe("monetary");
    expect(result.pagination?.more_items_in_collection).toBe(false);
  });

  it("get_deal_field fetches a single field by id and captures extra_fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: 42,
          key: "ffk9s9",
          name: "Contract Value",
          field_type: "monetary",
          mandatory_flag: false,
          bulk_edit_allowed: true,
        },
      }),
    );

    const field = await createClient().getDealField({ field_id: 42 });
    expect(field.id).toBe(42);
    expect(field.key).toBe("ffk9s9");
    expect(field.extra_fields).toHaveProperty("bulk_edit_allowed", true);
  });

  it("maps a 404 on get_deal_field to a typed not-found error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "not found" }, 404),
    );
    await expect(createClient().getDealField({ field_id: 99999 })).rejects.toBeInstanceOf(
      PipedriveNotFoundError,
    );
  });

  it("fetchAllDealFields pages through v1 offsets", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(
          dealFieldsPage([{ id: 1, key: "hash1", name: "Field1", field_type: "varchar" }], {
            start: 0,
            limit: 500,
            more_items_in_collection: true,
            next_start: 500,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          dealFieldsPage([{ id: 2, key: "hash2", name: "Field2", field_type: "varchar" }], {
            start: 500,
            limit: 500,
            more_items_in_collection: false,
            next_start: null,
          }),
        ),
      );

    const fields = await createClient().fetchAllDealFields();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new URL(String((spy.mock.calls[1] as unknown[])[0])).searchParams.get("start")).toBe("500");
    expect(fields.map((f) => f.key)).toEqual(["hash1", "hash2"]);
  });

  it("refresh_field_registry rebuilds and reports field_count/version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        dealFieldsPage([{ id: 1, key: "hash1", name: "Priority", field_type: "varchar" }], {
          start: 0,
          limit: 500,
          more_items_in_collection: false,
          next_start: null,
        }),
      ),
    );

    const result = await createClient().refreshFieldRegistry();
    expect(result.success).toBe(true);
    expect(result.field_count).toBe(1);
    expect(result.version).toHaveLength(16);
    expect(result.message).toContain("refreshed successfully");
  });

  it("refresh_field_registry reports failure gracefully when the fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 401));
    const result = await createClient().refreshFieldRegistry();
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to refresh registry");
  });
});

describe("PipedriveClient.getDeal", () => {
  let dir: string;
  let cachePath: string;

  function createClient(): PipedriveClient {
    return new PipedriveClient({
      apiToken: "secret",
      domain: "acme",
      timeoutMs: 1_000,
      registryOptions: { cachePath },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pd-getdeal-"));
    cachePath = path.join(dir, "registry.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const dealBody = {
    success: true,
    data: {
      id: 123,
      title: "Test Deal",
      value: 40000,
      currency: "USD",
      status: "open",
      stage_id: 2,
      pipeline_id: 1,
      person_id: 10,
      org_id: 20,
      owner_id: 30,
      expected_close_date: "2026-07-30",
      add_time: "2026-01-01T10:00:00Z",
      update_time: "2026-06-01T10:00:00Z",
      won_time: null,
      custom_fields: { hashP: 26 },
    },
  };

  const fieldsBody = dealFieldsPage(
    [{ id: 1, key: "hashP", name: "Priority", field_type: "enum", options: [{ id: 26, label: "High" }] }],
    { start: 0, limit: 500, more_items_in_collection: false, next_start: null },
  );

  it("full mode returns standard fields, deal URL, and normalized custom fields", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/deals/123")) return jsonResponse(dealBody);
      if (url.includes("/dealFields")) return jsonResponse(fieldsBody);
      throw new Error(`unexpected url ${url}`);
    });

    const detail = await createClient().getDeal({ deal_id: 123 });

    expect(detail).toMatchObject({
      id: 123,
      title: "Test Deal",
      value: 40000,
      currency: "USD",
      status: "open",
      stage_id: 2,
      pipeline_id: 1,
      person_id: 10,
      org_id: 20,
      user_id: 30,
      expected_close_date: "2026-07-30",
      add_time: "2026-01-01T10:00:00Z",
      won_time: null,
      deal_url: "https://acme.pipedrive.com/deal/123",
    });
    expect(detail.normalized_extra_fields).toEqual({ Priority: "High" });
    expect(detail.normalized_field_metadata?.Priority).toEqual({ key: "hashP", type: "enum" });
    expect(spy).toHaveBeenCalled();
  });

  it("lean mode strips normalized fields and never fetches the field schema", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/deals/123")) return jsonResponse(dealBody);
      if (url.includes("/v1/users")) return jsonResponse({ data: [] });
      throw new Error(`unexpected url ${url}`);
    });

    const detail = await createClient().getDeal({ deal_id: 123, output_type: "lean" });

    expect(detail.normalized_extra_fields).toBeUndefined();
    expect(detail.normalized_field_metadata).toBeUndefined();
    expect(detail.deal_url).toBe("https://acme.pipedrive.com/deal/123");
    // Deal + owner-name lookup only — no dealFields call.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.some(([u]) => String(u).includes("dealFields"))).toBe(false);
  });
});
