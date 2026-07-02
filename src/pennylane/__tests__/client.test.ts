import { afterEach, describe, expect, it, vi } from "vitest";
import { PennylaneClient } from "../client.js";
import {
  PennylaneAuthError,
  PennylaneNotFoundError,
  PennylaneRateLimitError,
} from "../errors.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("PennylaneClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Bearer auth against API v2 and returns a page of invoices", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [{ id: 42, invoice_number: "F-2026-1", amount: "230.32", date: "2026-04-03" }],
        has_more: false,
        next_cursor: null,
      }),
    );
    const client = new PennylaneClient({ apiToken: "secret-token" });

    const result = await client.listInvoices({});

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.id).toBe("42");
    expect(result.invoices[0]?.amount).toBe("230.32");
    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customer_invoices?limit=20",
    );
  });

  it("walks the cursor transparently across pages when no cursor is given", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 1, amount: "10.00" }],
          has_more: true,
          next_cursor: "CURSOR_2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 2, amount: "20.00" }],
          has_more: false,
          next_cursor: null,
        }),
      );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listInvoices({ limit: 50 });

    expect(result.invoices.map((i) => i.id)).toEqual(["1", "2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customer_invoices?limit=50",
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customer_invoices?cursor=CURSOR_2&limit=50",
    );
  });

  it("returns a single page when an explicit cursor is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [{ id: 3, amount: "5.00" }],
        has_more: true,
        next_cursor: "CURSOR_NEXT",
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listInvoices({ cursor: "CURSOR_START" });

    expect(result.invoices).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customer_invoices?cursor=CURSOR_START&limit=20",
    );
  });

  it("keeps money as decimal strings even when the API returns a number", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [{ id: 7, amount: 230.32 }], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listInvoices({});

    expect(result.invoices[0]?.amount).toBe("230.32");
    expect(typeof result.invoices[0]?.amount).toBe("string");
  });

  it("retries on 429 honoring retry-after, then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 9, amount: "1.00" }], has_more: false, next_cursor: null }),
      );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listInvoices({});

    expect(result.invoices).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws PennylaneRateLimitError after exhausting retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await expect(client.listInvoices({})).rejects.toBeInstanceOf(PennylaneRateLimitError);
  });

  it("maps 401 to PennylaneAuthError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad auth" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await expect(client.verifyToken()).rejects.toBeInstanceOf(PennylaneAuthError);
  });

  it("maps 404 to PennylaneNotFoundError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await expect(client.listInvoices({})).rejects.toBeInstanceOf(PennylaneNotFoundError);
  });

  it("self-throttles to 25 requests per 5 seconds per token", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(() => Promise.resolve(jsonResponse({ id: 1 })));
      const client = new PennylaneClient({ apiToken: "t" });

      // Fire 26 requests. The first 25 fit in the window; the 26th must wait
      // for the window to advance, so it stays pending until timers advance.
      const calls = Array.from({ length: 26 }, () => client.verifyToken());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(25);

      await vi.advanceTimersByTimeAsync(5001);
      await Promise.all(calls);
      expect(fetchSpy).toHaveBeenCalledTimes(26);
    } finally {
      vi.useRealTimers();
    }
  });

  it("searchInvoices AND-combines filters into one filter param", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [{ id: 5, amount: "9.00" }], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.searchInvoices({
      customerId: 111,
      externalReference: "deal-7",
      status: ["paid", "sent"],
      dateFrom: "2025-06-01",
      dateTo: "2025-06-30",
    });

    expect(result.invoices).toHaveLength(1);
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/external/v2/customer_invoices");
    const filter = JSON.parse(url.searchParams.get("filter") ?? "null");
    expect(filter).toEqual([
      { field: "customer_id", operator: "eq", value: 111 },
      { field: "external_reference", operator: "eq", value: "deal-7" },
      { field: "status", operator: "in", value: ["paid", "sent"] },
      { field: "date", operator: "gteq", value: "2025-06-01" },
      { field: "date", operator: "lteq", value: "2025-06-30" },
    ]);
  });

  it("searchInvoices URL-encodes the filter exactly once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await client.searchInvoices({ externalReference: "deal-7" });

    const raw = String(fetchSpy.mock.calls[0]?.[0]);
    // Single-encoded: the JSON array's "[{" is "%5B%7B", never double-encoded "%255B".
    expect(raw).toContain("filter=%5B%7B");
    expect(raw).not.toContain("%255B");
  });

  it("searchInvoices uses status eq for a single status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await client.searchInvoices({ status: "paid" });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "status", operator: "eq", value: "paid" },
    ]);
  });

  it("searchInvoices omits the filter param when no filters are given", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await client.searchInvoices({});

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.has("filter")).toBe(false);
  });

  it("searchInvoices re-sends the same filter on every page while walking the cursor", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 1, amount: "1.00" }], has_more: true, next_cursor: "C2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 2, amount: "2.00" }], has_more: false, next_cursor: null }),
      );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.searchInvoices({ externalReference: "deal-9" });

    expect(result.invoices.map((i) => i.id)).toEqual(["1", "2"]);
    const firstFilter = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get("filter");
    const secondUrl = new URL(String(fetchSpy.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("filter")).toBe(firstFilter);
    expect(secondUrl.searchParams.get("cursor")).toBe("C2");
  });

  it("verifies a token via GET /me", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 1, name: "Acme" }));
    const client = new PennylaneClient({ apiToken: "t" });

    await client.verifyToken();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/me",
    );
  });
});
