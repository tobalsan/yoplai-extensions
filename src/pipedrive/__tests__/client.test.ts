import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PipedriveClient, inCloseDateRange, inWonDateRange } from "../client.js";
import {
  PipedriveAuthError,
  PipedriveNotFoundError,
  PipedriveRateLimitError,
  PipedriveValidationError,
} from "../errors.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createClient(): PipedriveClient {
  return new PipedriveClient({ apiToken: "secret-token", domain: "acme", timeoutMs: 1_000 });
}

function rawDeal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    title: "Deal 1",
    value: 1000,
    currency: "EUR",
    status: "open",
    stage_id: 3,
    pipeline_id: 2,
    person_id: 10,
    org_id: 20,
    owner_id: 30,
    expected_close_date: "2025-07-15",
    won_time: null,
    ...overrides,
  };
}

function url(spy: ReturnType<typeof vi.spyOn>, call = 0): URL {
  return new URL(String((spy.mock.calls[call] as unknown[])?.[0]));
}

describe("PipedriveClient.validate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks auth via users/me", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { id: 42, name: "API User" } }));

    const result = await createClient().validate();

    expect(result).toEqual({ ok: true, account: { id: 42, name: "API User" } });
    const u = url(spy);
    expect(u.pathname).toBe("/api/v1/users/me");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
  });
});

describe("PipedriveClient.listDeals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets the v2 deals endpoint with the api_token auth param", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [rawDeal()], additional_data: {} }));

    await createClient().listDeals({});

    const u = url(spy);
    expect(u.origin).toBe("https://acme.pipedrive.com");
    expect(u.pathname).toBe("/api/v2/deals");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
    expect((spy.mock.calls[0] as unknown[])?.[1]).toMatchObject({ method: "GET" });
  });

  it("defaults status to open and applies server-side filters", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [], additional_data: {} }));

    await createClient().listDeals({
      pipeline_id: 2,
      stage_id: 3,
      person_id: 10,
      org_id: 20,
      user_id: 30,
    });

    const q = url(spy).searchParams;
    expect(q.get("status")).toBe("open");
    expect(q.get("pipeline_id")).toBe("2");
    expect(q.get("stage_id")).toBe("3");
    expect(q.get("person_id")).toBe("10");
    expect(q.get("org_id")).toBe("20");
    expect(q.get("user_id")).toBe("30");
    expect(q.get("sort_by")).toBe("update_time");
    expect(q.get("sort_direction")).toBe("desc");
    expect(q.get("limit")).toBe("100");
  });

  it("returns a lean projection and constructs the deal_url", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ data: [rawDeal({ id: 42 })], additional_data: { next_cursor: null } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 30, name: "Jane Owner", active_flag: true }] }));

    const result = await createClient().listDeals({});

    expect(result.count).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.deals[0]).toEqual({
      id: 42,
      title: "Deal 1",
      value: 1000,
      currency: "EUR",
      status: "open",
      stage_id: 3,
      pipeline_id: 2,
      person_id: 10,
      org_id: 20,
      user_id: 30,
      owner_name: "Jane Owner",
      expected_close_date: "2025-07-15",
      won_time: null,
      local_won_date: null,
      local_close_date: null,
      deal_url: "https://acme.pipedrive.com/deal/42",
    });
    // Lean: no raw/custom fields leak through.
    expect(Object.keys(result.deals[0])).toHaveLength(16);
  });

  it("passes an explicit cursor through and returns the native next_cursor without a range", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [rawDeal()], additional_data: { next_cursor: "next-1" } }));

    const result = await createClient().listDeals({ cursor: "cur-0" });

    expect(url(spy).searchParams.get("cursor")).toBe("cur-0");
    expect(spy).toHaveBeenCalledTimes(2); // + owner-name users lookup
    expect(result.next_cursor).toBe("next-1");
  });

  it("assembles multiple cursor pages to fill a close-date-filtered page with no gaps or dupes", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            rawDeal({ id: 1, expected_close_date: "2025-06-30" }), // before range → skip
            rawDeal({ id: 2, expected_close_date: "2025-07-10" }), // in range
          ],
          additional_data: { next_cursor: "page-2" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            rawDeal({ id: 3, expected_close_date: null }), // no close date → skip
            rawDeal({ id: 4, expected_close_date: "2025-07-20" }), // in range
          ],
          additional_data: { next_cursor: null },
        }),
      );

    const result = await createClient().listDeals({
      expected_close_from: "2025-07-01",
      expected_close_to: "2025-07-31",
    });

    expect(spy).toHaveBeenCalledTimes(3); // + owner-name users lookup
    expect(url(spy, 1).searchParams.get("cursor")).toBe("page-2");
    expect(result.deals.map((d) => d.id)).toEqual([2, 4]);
    expect(result.next_cursor).toBeNull();
    expect(result.count).toBe(2);
  });

  it("assembles multiple cursor pages to fill a won-date-filtered page with no gaps or dupes", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            rawDeal({ id: 1, status: "won", won_time: "2026-05-30 09:00:00" }), // before range → skip
            rawDeal({ id: 2, status: "won", won_time: "2026-06-10 09:00:00" }), // in range
          ],
          additional_data: { next_cursor: "page-2" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            rawDeal({ id: 3, status: "won", won_time: null }), // not won → skip
            rawDeal({ id: 4, status: "won", won_time: "2026-06-30 23:59:00" }), // in range
          ],
          additional_data: { next_cursor: null },
        }),
      );

    const result = await createClient().listDeals({
      status: "won",
      won_from: "2026-06-01",
      won_to: "2026-06-30",
    });

    expect(spy).toHaveBeenCalledTimes(3); // + owner-name users lookup
    expect(url(spy, 1).searchParams.get("cursor")).toBe("page-2");
    expect(result.deals.map((d) => d.id)).toEqual([2, 4]);
    expect(result.deals.map((d) => d.won_time)).toEqual([
      "2026-06-10 09:00:00",
      "2026-06-30 23:59:00",
    ]);
    expect(result.next_cursor).toBeNull();
    expect(result.count).toBe(2);
  });

  it("stops paging once the requested limit of in-range matches is reached and returns a resume cursor", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({
          data: [
            rawDeal({ id: 1, expected_close_date: "2025-07-05" }),
            rawDeal({ id: 2, expected_close_date: "2025-07-06" }),
          ],
          additional_data: { next_cursor: "more" },
        }),
      );

    const result = await createClient().listDeals({
      expected_close_from: "2025-07-01",
      limit: 2,
    });

    expect(spy).toHaveBeenCalledTimes(2); // + owner-name users lookup
    expect(result.deals.map((d) => d.id)).toEqual([1, 2]);
    expect(result.next_cursor).toBe("more");
  });
});

function rawFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    name: "sale-info.xlsx",
    file_type: "xlsx",
    file_size: 20480,
    deal_id: 42,
    add_time: "2025-07-01 10:00:00",
    url: "https://acme.pipedrive.com/file/100",
    remote_location: null,
    ...overrides,
  };
}

describe("PipedriveClient.listDealFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets the v1 deal files endpoint and projects lean metadata", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [rawFile()], additional_data: {} }));

    const result = await createClient().listDealFiles({ deal_id: 42 });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v1/deals/42/files");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
    expect(result.count).toBe(1);
    expect(result.files[0]).toEqual({
      id: 100,
      name: "sale-info.xlsx",
      type: "xlsx",
      size: 20480,
      deal_id: 42,
      add_time: "2025-07-01 10:00:00",
      url: "https://acme.pipedrive.com/file/100",
      remote_location: null,
    });
  });

  it("falls back to file_name and derives type from the extension", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [rawFile({ name: null, file_name: "contract.PDF", file_type: null, file_size: null })],
        additional_data: {},
      }),
    );

    const result = await createClient().listDealFiles({ deal_id: 42 });
    expect(result.files[0]?.name).toBe("contract.PDF");
    expect(result.files[0]?.type).toBe("pdf");
    expect(result.files[0]?.size).toBeNull();
  });

  it("returns an empty list when a deal has no files", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: [], additional_data: {} }));
    const result = await createClient().listDealFiles({ deal_id: 42 });
    expect(result).toEqual({ files: [], count: 0 });
  });
});

describe("PipedriveClient.downloadFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns raw bytes as base64 without parsing, preserving byte integrity", async () => {
    // Bytes that are NOT valid UTF-8 — round-tripping via base64 must be lossless.
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80]);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(original, {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      }),
    );

    const result = await createClient().downloadFile({ file_id: 100 });

    expect(url(spy).pathname).toBe("/api/v1/files/100/download");
    expect(result.encoding).toBe("base64");
    expect(result.size).toBe(original.length);
    expect(result.mime_type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // Decode and confirm the bytes are byte-for-byte identical.
    expect(Buffer.from(result.content_base64, "base64").equals(original)).toBe(true);
  });

  it("maps a 404 on a missing file to a typed not-found error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(createClient().downloadFile({ file_id: 999 })).rejects.toBeInstanceOf(
      PipedriveNotFoundError,
    );
  });

  it("surfaces a clear error with the external link when a file is stored remotely (e.g. Google Drive)", async () => {
    const resp = new Response("unauthorized", { status: 401 });
    Object.defineProperty(resp, "url", {
      value: "https://drive.google.com/file/d/abc/view",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(resp);

    await expect(createClient().downloadFile({ file_id: 749981 })).rejects.toMatchObject({
      message: expect.stringContaining("stored remotely"),
    });
    await expect(createClient().downloadFile({ file_id: 749981 })).rejects.toMatchObject({
      message: expect.stringContaining("https://drive.google.com/file/d/abc/view"),
    });
  });
});

describe("PipedriveClient retry and error mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries 429 honoring Retry-After then succeeds", async () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler) => {
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse({ data: [rawDeal()], additional_data: {} }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await createClient().listDeals({});

    expect(spy).toHaveBeenCalledTimes(3); // + owner-name users lookup
    expect(result.count).toBe(1);
    setTimeoutSpy.mockRestore();
  });

  it("retries 5xx then succeeds", async () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler) => {
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [], additional_data: {} }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await createClient().listDeals({});

    expect(spy).toHaveBeenCalledTimes(3); // + owner-name users lookup
    setTimeoutSpy.mockRestore();
  });

  it.each([
    [401, PipedriveAuthError],
    [403, PipedriveAuthError],
    [404, PipedriveNotFoundError],
    [400, PipedriveValidationError],
    [422, PipedriveValidationError],
  ])("maps status %s to a typed error", async (status, ErrorType) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "boom" }, status),
    );

    await expect(createClient().listDeals({})).rejects.toBeInstanceOf(ErrorType);
  });

  it("throws PipedriveRateLimitError after exhausting retries on 429", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 429));

    await expect(createClient().listDeals({})).rejects.toBeInstanceOf(PipedriveRateLimitError);
  });

  it("throws PipedriveServerError after exhausting retries on 5xx", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const upstreamBody = "Pipedrive upstream failure: " + "x".repeat(600);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(upstreamBody, { status: 500 }),
    );

    await expect(createClient().listDeals({})).rejects.toMatchObject({
      endpoint: "deals",
      status: 500,
      responseBody: upstreamBody.slice(0, 500),
      message: expect.stringContaining(`deals: ${upstreamBody.slice(0, 500)}`),
    });
  });
});

describe("PipedriveClient pipelines and stages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists pipelines from v2 with a lean projection and cursor", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          { id: 1, name: "Sales", order_nr: 0, is_selected: true, is_deleted: false },
          { id: 2, name: "Renewals", order_nr: 1, is_selected: false, is_deleted: true },
        ],
        additional_data: { next_cursor: "pipe-2" },
      }),
    );

    const result = await createClient().listPipelines({ cursor: "pipe-1", limit: 50 });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v2/pipelines");
    expect(u.searchParams.get("cursor")).toBe("pipe-1");
    expect(u.searchParams.get("limit")).toBe("50");
    expect(result.next_cursor).toBe("pipe-2");
    expect(result.count).toBe(2);
    expect(result.pipelines[0]).toEqual({
      id: 1,
      name: "Sales",
      order_nr: 0,
      is_selected: true,
      is_deal_probability_enabled: null,
      active: true,
    });
    // is_deleted:true maps to active:false.
    expect(result.pipelines[1].active).toBe(false);
  });

  it("fetches a single pipeline by id", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { id: 7, name: "Sales", order_nr: 3 } }));

    const result = await createClient().getPipeline(7);

    expect(url(spy).pathname).toBe("/api/v2/pipelines/7");
    expect(result).toMatchObject({ id: 7, name: "Sales", order_nr: 3 });
  });

  it("lists stages with an optional pipeline_id filter", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [{ id: 5, name: "Won", pipeline_id: 1, order_nr: 4, deal_probability: 100 }],
        additional_data: { next_cursor: null },
      }),
    );

    const result = await createClient().listStages({ pipeline_id: 1 });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v2/stages");
    expect(u.searchParams.get("pipeline_id")).toBe("1");
    expect(result.stages[0]).toMatchObject({
      id: 5,
      name: "Won",
      pipeline_id: 1,
      order_nr: 4,
      deal_probability: 100,
    });
    expect(result.next_cursor).toBeNull();
  });

  it("omits pipeline_id from the stages query when not provided", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [], additional_data: {} }));

    await createClient().listStages({});

    expect(url(spy).searchParams.get("pipeline_id")).toBeNull();
  });

  it("fetches a single stage by id", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { id: 9, name: "Final negotiation", pipeline_id: 1 } }));

    const result = await createClient().getStage(9);

    expect(url(spy).pathname).toBe("/api/v2/stages/9");
    expect(result).toMatchObject({ id: 9, name: "Final negotiation", pipeline_id: 1 });
  });
});

describe("PipedriveClient deal products and discounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists a deal's products (line items) with qty, unit price and billing frequency", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 100,
            product_id: 55,
            name: "Acme License",
            quantity: 3,
            item_price: 120,
            sum: 360,
            currency: "EUR",
            billing_frequency: "monthly",
            billing_frequency_cycles: 12,
            tax: 20,
            tax_method: "exclusive",
            product_variation_id: 7,
          },
        ],
        additional_data: { next_cursor: "prod-2" },
      }),
    );

    const result = await createClient().listDealProducts({ deal_id: 3782, limit: 100 });

    expect(url(spy).pathname).toBe("/api/v2/deals/3782/products");
    expect(result.deal_id).toBe(3782);
    expect(result.next_cursor).toBe("prod-2");
    expect(result.count).toBe(1);
    expect(result.products[0]).toMatchObject({
      id: 100,
      product_id: 55,
      name: "Acme License",
      quantity: 3,
      item_price: 120,
      billing_frequency: "monthly",
      billing_frequency_cycles: 12,
      tax: 20,
      product_variation_id: 7,
    });
  });

  it("lists a deal's deal-level discounts", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [{ id: "abc-123", description: "Early bird", amount: 10, type: "percentage" }],
        additional_data: { next_cursor: null },
      }),
    );

    const result = await createClient().listDealDiscounts({ deal_id: 3782 });

    expect(url(spy).pathname).toBe("/api/v2/deals/3782/discounts");
    expect(result.deal_id).toBe(3782);
    expect(result.discounts[0]).toEqual({
      id: "abc-123",
      description: "Early bird",
      amount: 10,
      type: "percentage",
    });
    expect(result.next_cursor).toBeNull();
  });
});

describe("inCloseDateRange", () => {
  it("excludes deals without an expected close date when a bound is set", () => {
    expect(inCloseDateRange(null, "2025-07-01", null)).toBe(false);
    expect(inCloseDateRange(undefined, null, "2025-07-31")).toBe(false);
  });

  it("applies inclusive lower and upper bounds", () => {
    expect(inCloseDateRange("2025-07-01", "2025-07-01", "2025-07-31")).toBe(true);
    expect(inCloseDateRange("2025-07-31", "2025-07-01", "2025-07-31")).toBe(true);
    expect(inCloseDateRange("2025-06-30", "2025-07-01", "2025-07-31")).toBe(false);
    expect(inCloseDateRange("2025-08-01", "2025-07-01", "2025-07-31")).toBe(false);
  });
});

describe("inWonDateRange", () => {
  it("excludes deals without a won_time when a bound is set", () => {
    expect(inWonDateRange(null, "2026-06-01", null)).toBe(false);
    expect(inWonDateRange(undefined, null, "2026-06-30")).toBe(false);
  });

  it("applies inclusive lower and upper bounds, comparing only the date portion", () => {
    expect(inWonDateRange("2026-06-01 00:00:00", "2026-06-01", "2026-06-30")).toBe(true);
    expect(inWonDateRange("2026-06-30 23:59:00", "2026-06-01", "2026-06-30")).toBe(true);
    expect(inWonDateRange("2026-05-31 23:59:00", "2026-06-01", "2026-06-30")).toBe(false);
    expect(inWonDateRange("2026-07-01 00:00:00", "2026-06-01", "2026-06-30")).toBe(false);
  });
});

function searchItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result_score: 0.9,
    item: {
      id: 3776,
      type: "deal",
      title: "Tunnel - nemolink - try & buy",
      value: 8448.19,
      currency: "EUR",
      status: "won",
      stage: { id: 4, name: "Final negotiation" },
      pipeline: { id: 1 },
      person: { id: 33864, name: "Scott Maybury" },
      organization: { id: 8949, name: "NemoLink" },
      ...overrides,
    },
  };
}

describe("PipedriveClient.searchDeals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v2 /deals/search with the term, title field, and auth param", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { items: [] }, additional_data: { next_cursor: null } }));

    await createClient().searchDeals({ term: "try & buy" });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v2/deals/search");
    expect(u.searchParams.get("term")).toBe("try & buy");
    expect(u.searchParams.get("fields")).toBe("title");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
  });

  it("passes server-side status/person/org/exact_match filters and maps org_id to organization_id", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { items: [] }, additional_data: {} }));

    await createClient().searchDeals({
      term: "try",
      status: "open",
      person_id: 33864,
      org_id: 8949,
      exact_match: true,
    });

    const q = url(spy).searchParams;
    expect(q.get("status")).toBe("open");
    expect(q.get("person_id")).toBe("33864");
    expect(q.get("organization_id")).toBe("8949");
    expect(q.has("org_id")).toBe(false);
    expect(q.get("exact_match")).toBe("true");
  });

  it("returns a lean projection with a constructed deal_url and passes cursor through", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: { items: [searchItem()] },
        additional_data: { next_cursor: "eyJzdGFydCI6NX0" },
      }),
    );

    const result = await createClient().searchDeals({ term: "try & buy", cursor: "cur-0" });

    expect(url(spy).searchParams.get("cursor")).toBe("cur-0");
    expect(result.count).toBe(1);
    expect(result.next_cursor).toBe("eyJzdGFydCI6NX0");
    expect(result.deals[0]).toEqual({
      id: 3776,
      title: "Tunnel - nemolink - try & buy",
      status: "won",
      value: 8448.19,
      currency: "EUR",
      stage_id: 4,
      pipeline_id: 1,
      person_id: 33864,
      org_id: 8949,
      result_score: 0.9,
      deal_url: "https://acme.pipedrive.com/deal/3776",
    });
    expect(Object.keys(result.deals[0])).toHaveLength(11);
  });
});

describe("PipedriveClient.listDealNotes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /notes for the deal and flattens author + timestamps", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 22585,
            deal_id: 3776,
            content: "PO to validate by Floriane",
            user_id: 15057258,
            person_id: 33864,
            org_id: null,
            add_time: "2026-01-26 13:42:18",
            update_time: "2026-01-26 13:42:18",
            user: { name: "Eric" },
          },
        ],
        additional_data: { pagination: { more_items_in_collection: false } },
      }),
    );

    const result = await createClient().listDealNotes({ deal_id: 3776 });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v1/notes");
    expect(u.searchParams.get("deal_id")).toBe("3776");
    expect(result.count).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.notes[0]).toEqual({
      id: 22585,
      deal_id: 3776,
      lead_id: null,
      content: "PO to validate by Floriane",
      user_id: 15057258,
      user_name: "Eric",
      person_id: 33864,
      org_id: null,
      add_time: "2026-01-26 13:42:18",
      update_time: "2026-01-26 13:42:18",
    });
  });

  it("translates v1 start-based pagination into an opaque cursor round-trip", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [{ id: 1, user: { name: "Eric" } }],
          additional_data: {
            pagination: { more_items_in_collection: true, next_start: 2 },
          },
        }),
      ),
    );

    const first = await createClient().listDealNotes({ deal_id: 3776, limit: 1 });
    expect(first.next_cursor).toBe("2");

    await createClient().listDealNotes({ deal_id: 3776, cursor: first.next_cursor!, limit: 1 });
    expect(url(spy, 1).searchParams.get("start")).toBe("2");
  });
});

describe("PipedriveClient.listDealActivities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /activities and projects the activity fields", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 10834,
            deal_id: 3776,
            type: "task",
            subject: "Suivre envoi de la datasheet",
            note: null,
            done: false,
            due_date: "2021-12-09",
            due_time: "",
            marked_as_done_time: "",
            user_id: 12884450,
            add_time: "2021-12-02 21:48:45",
            update_time: "2021-12-06 09:46:09",
          },
        ],
        additional_data: { pagination: { more_items_in_collection: false } },
      }),
    );

    const result = await createClient().listDealActivities({ deal_id: 3776 });

    expect(url(spy).pathname).toBe("/api/v1/activities");
    expect(result.count).toBe(1);
    expect(result.activities[0]).toEqual({
      id: 10834,
      deal_id: 3776,
      type: "task",
      subject: "Suivre envoi de la datasheet",
      note: null,
      done: false,
      due_date: "2021-12-09",
      due_time: null,
      marked_as_done_time: null,
      user_id: 12884450,
      add_time: "2021-12-02 21:48:45",
      update_time: "2021-12-06 09:46:09",
    });
  });

  it("maps the done filter to the v1 0/1 query param", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse({ data: [], additional_data: {} })));

    await createClient().listDealActivities({ deal_id: 3776, done: true });
    expect(url(spy).searchParams.get("done")).toBe("1");

    await createClient().listDealActivities({ deal_id: 3776, done: false });
    expect(url(spy, 1).searchParams.get("done")).toBe("0");
  });
});

describe("PipedriveClient users and owner_name", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists users from v1 /users with active flag", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          { id: 30, name: "Jane Owner", email: "jane@acme.com", active_flag: true },
          { id: 31, name: "Gone User", email: null, active_flag: false },
        ],
      }),
    );

    const result = await createClient().listUsers();

    expect(url(spy).pathname).toBe("/api/v1/users");
    expect(result).toEqual({
      users: [
        { id: 30, name: "Jane Owner", email: "jane@acme.com", active: true },
        { id: 31, name: "Gone User", email: null, active: false },
      ],
      count: 2,
    });
  });

  it("caches the users lookup across deal reads", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/v1/users")) return jsonResponse({ data: [{ id: 30, name: "Jane Owner", active_flag: true }] });
      if (u.includes("/v2/deals/7")) return jsonResponse({ data: rawDeal({ id: 7 }) });
      return jsonResponse({ data: [rawDeal()], additional_data: {} });
    });
    const client = createClient();

    const list = await client.listDeals({});
    const detail = await client.getDeal({ deal_id: 7, output_type: "lean" });

    expect(list.deals[0].owner_name).toBe("Jane Owner");
    expect(detail.owner_name).toBe("Jane Owner");
    expect(spy.mock.calls.filter(([u]) => String(u).includes("/v1/users"))).toHaveLength(1);
  });

  it("leaves owner_name null when the users lookup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v1/users")) return jsonResponse({ error: "forbidden" }, 403);
      return jsonResponse({ data: [rawDeal()], additional_data: {} });
    });

    const result = await createClient().listDeals({});

    expect(result.deals[0].user_id).toBe(30);
    expect(result.deals[0].owner_name).toBeNull();
  });
});

describe("PipedriveClient.listDeals custom_fields", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const FC = "1e0f8400816db3aa4b28ef5f139b8980b85457a4";
  const fields = [
    { id: 1, key: FC, name: "Forecast category", field_type: "enum", options: [{ id: 707, label: "Pipeline" }, { id: 708, label: "Upside" }] },
    { id: 2, key: "abc123", name: "Region", field_type: "varchar" },
  ];
  function mockApi() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("dealFields")) return jsonResponse({ data: fields, additional_data: { pagination: { more_items_in_collection: false } } });
      if (u.includes("/v1/users")) return jsonResponse({ data: [] });
      return jsonResponse({
        data: [rawDeal({ id: 1, custom_fields: { [FC]: 708 }, local_won_date: "2026-09-01" }), rawDeal({ id: 2, custom_fields: { [FC]: null } })],
        additional_data: {},
      });
    });
  }
  function client(): PipedriveClient {
    const cachePath = path.join(os.tmpdir(), `pd-registry-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    return new PipedriveClient({ apiToken: "t", domain: "acme", timeoutMs: 1_000, registryOptions: { cachePath } });
  }

  it("resolves names to keys, sends them server-side, and returns readable values", async () => {
    const spy = mockApi();
    const result = await client().listDeals({ custom_fields: ["forecast category"] });

    const dealsCall = spy.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname === "/api/v2/deals");
    expect(dealsCall?.searchParams.get("custom_fields")).toBe(FC);
    expect(result.deals[0].custom_fields).toEqual({ "Forecast category": "Upside" });
    expect(result.deals[0].local_won_date).toBe("2026-09-01");
    expect(result.deals[1].custom_fields).toEqual({ "Forecast category": null });
  });

  it("rejects unknown field names before calling the deals endpoint", async () => {
    const spy = mockApi();
    await expect(client().listDeals({ custom_fields: ["Nope"] })).rejects.toThrow(/Unknown deal custom field\(s\): Nope/);
    expect(spy.mock.calls.some(([u]) => new URL(String(u)).pathname === "/api/v2/deals")).toBe(false);
  });

  it("omits custom_fields when not requested", async () => {
    mockApi();
    const result = await client().listDeals({});
    expect(result.deals[0].custom_fields).toBeUndefined();
  });
});
