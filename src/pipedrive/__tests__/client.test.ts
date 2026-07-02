import { afterEach, describe, expect, it, vi } from "vitest";

import { PipedriveClient, inCloseDateRange } from "../client.js";
import {
  PipedriveAuthError,
  PipedriveNotFoundError,
  PipedriveRateLimitError,
  PipedriveServerError,
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
    ...overrides,
  };
}

function url(spy: ReturnType<typeof vi.spyOn>, call = 0): URL {
  return new URL(String((spy.mock.calls[call] as unknown[])?.[0]));
}

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ data: [rawDeal({ id: 42 })], additional_data: { next_cursor: null } }),
    );

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
      expected_close_date: "2025-07-15",
      deal_url: "https://acme.pipedrive.com/deal/42",
    });
    // Lean: no raw/custom fields leak through.
    expect(Object.keys(result.deals[0])).toHaveLength(12);
  });

  it("passes an explicit cursor through and returns the native next_cursor without a range", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [rawDeal()], additional_data: { next_cursor: "next-1" } }));

    const result = await createClient().listDeals({ cursor: "cur-0" });

    expect(url(spy).searchParams.get("cursor")).toBe("cur-0");
    expect(spy).toHaveBeenCalledTimes(1);
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

    expect(spy).toHaveBeenCalledTimes(2);
    expect(url(spy, 1).searchParams.get("cursor")).toBe("page-2");
    expect(result.deals.map((d) => d.id)).toEqual([2, 4]);
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

    expect(spy).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce(jsonResponse({ data: [rawDeal()], additional_data: {} }));

    const result = await createClient().listDeals({});

    expect(spy).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(jsonResponse({ data: [], additional_data: {} }));

    await createClient().listDeals({});

    expect(spy).toHaveBeenCalledTimes(2);
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 500));

    await expect(createClient().listDeals({})).rejects.toBeInstanceOf(PipedriveServerError);
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
