import { afterEach, describe, expect, it, vi } from "vitest";
import { PennylaneClient } from "../client.js";
import {
  PennylaneAuthError,
  PennylaneGuardRefusedError,
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

  it("getInvoice fetches a single invoice by id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 88, amount: "12.00", external_reference: "deal-1" }));
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.getInvoice({ id: 88 });

    expect(result.invoice.id).toBe("88");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customer_invoices/88",
    );
  });

  it("listQuotes walks the cursor and validates against the quote schema", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 1, status: "pending", amount: "100.00" }],
          has_more: true,
          next_cursor: "Q2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 2, status: "accepted", amount: "200.00" }],
          has_more: false,
          next_cursor: null,
        }),
      );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listQuotes({});

    expect(result.quotes.map((q) => q.id)).toEqual(["1", "2"]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/quotes?limit=20",
    );
  });

  it("searchQuotes filters by customer_id server-side then matches external_reference client-side", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [
          { id: 1, external_reference: "deal-7", amount: "1.00" },
          { id: 2, external_reference: "deal-8", amount: "2.00" },
          { id: 3, external_reference: "deal-7", amount: "3.00" },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.searchQuotes({ customerId: 42, externalReference: "deal-7" });

    // Only customer_id is sent server-side; external_reference is NOT in the filter.
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "customer_id", operator: "eq", value: 42 },
    ]);
    // Client-side match narrows to the two deal-7 quotes.
    expect(result.quotes.map((q) => q.id)).toEqual(["1", "3"]);
  });

  it("searchQuotes maps a status list to a status in clause", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ items: [], has_more: false, next_cursor: null }));
    const client = new PennylaneClient({ apiToken: "t" });

    await client.searchQuotes({ status: ["pending", "accepted"] });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "status", operator: "in", value: ["pending", "accepted"] },
    ]);
  });

  it("getQuote fetches a single quote by id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 9, status: "pending" }));
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.getQuote({ id: 9 });

    expect(result.quote.id).toBe("9");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/quotes/9",
    );
  });

  it("getCustomer fetches by internal id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 123, name: "ACME", customer_type: "company" }));
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.getCustomer({ id: 123 });

    expect(result.customer.id).toBe("123");
    expect(result.customer.name).toBe("ACME");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/customers/123",
    );
  });

  it("getCustomer resolves by external_reference via an eq filter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [{ id: 55, name: "ACME", external_reference: "pipedrive-org-88" }],
        has_more: false,
        next_cursor: null,
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.getCustomer({ externalReference: "pipedrive-org-88" });

    expect(result.customer.id).toBe("55");
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/external/v2/customers");
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "external_reference", operator: "eq", value: "pipedrive-org-88" },
    ]);
  });

  it("getCustomer throws PennylaneNotFoundError when no external_reference match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [], has_more: false, next_cursor: null }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await expect(client.getCustomer({ externalReference: "missing" })).rejects.toBeInstanceOf(
      PennylaneNotFoundError,
    );
  });

  it("getCustomer rejects when neither id nor external_reference is given", async () => {
    const client = new PennylaneClient({ apiToken: "t" });
    await expect(client.getCustomer({})).rejects.toThrow(/exactly one/);
  });

  it("getCustomer rejects when both id and external_reference are given", async () => {
    const client = new PennylaneClient({ apiToken: "t" });
    await expect(
      client.getCustomer({ id: 1, externalReference: "x" }),
    ).rejects.toThrow(/exactly one/);
  });

  it("searchCustomers AND-combines external_reference, name, and customer_type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ items: [], has_more: false, next_cursor: null }));
    const client = new PennylaneClient({ apiToken: "t" });

    await client.searchCustomers({
      externalReference: "org-1",
      name: "ACME",
      customerType: "company",
    });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "external_reference", operator: "eq", value: "org-1" },
      { field: "name", operator: "eq", value: "ACME" },
      { field: "customer_type", operator: "eq", value: "company" },
    ]);
  });

  it("searchProducts filters by external_reference and validates products", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        items: [{ id: 7, label: "Widget", price_before_tax: "10.00", vat_rate: "FR_200" }],
        has_more: false,
        next_cursor: null,
      }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.searchProducts({ externalReference: "prod-1" });

    expect(result.products[0]?.id).toBe("7");
    expect(result.products[0]?.priceBeforeTax).toBe("10.00");
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/external/v2/products");
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual([
      { field: "external_reference", operator: "eq", value: "prod-1" },
    ]);
  });

  it("getProduct fetches a single product by id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 4, label: "Service", vat_rate: "FR_200" }));
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.getProduct({ id: 4 });

    expect(result.product.id).toBe("4");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://app.pennylane.com/api/external/v2/products/4",
    );
  });

  it("listVatRates returns the static VAT enum reference without a network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new PennylaneClient({ apiToken: "t" });

    const result = await client.listVatRates({});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.vatRates).toContainEqual({
      code: "FR_200",
      label: "France — standard rate",
      percentage: 20,
    });
    expect(result.vatRates.map((r) => r.code)).toContain("exempt");
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

  it("validates auth and API reachability", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ user: { id: 1 }, company: { id: 2 } }),
    );
    const client = new PennylaneClient({ apiToken: "t" });

    await expect(client.validate()).resolves.toEqual({
      ok: true,
      account: { user: { id: 1 }, company: { id: 2 } },
    });
  });

  describe("create_invoice_draft", () => {
    it("POSTs with draft: true and passes external_reference through (snake-cased)", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ id: 77, draft: true, status: "draft" }));
      const client = new PennylaneClient({ apiToken: "t" });

      const result = await client.createInvoiceDraft({
        customerId: 123,
        date: "2026-06-15",
        deadline: "2026-07-15",
        externalReference: "pipedrive-deal-4567",
        invoiceLines: [
          { label: "Consulting", quantity: 2, unit: "hour", rawCurrencyUnitPrice: "100.00", vatRate: "FR_200" },
        ],
      });

      expect(result.invoice.id).toBe("77");
      expect(result.invoice.draft).toBe(true);

      const call = fetchSpy.mock.calls[0];
      expect(call?.[1]?.method).toBe("POST");
      expect(String(call?.[0])).toBe(
        "https://app.pennylane.com/api/external/v2/customer_invoices",
      );
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.draft).toBe(true);
      expect(body.customer_id).toBe(123);
      expect(body.external_reference).toBe("pipedrive-deal-4567");
      expect(body.invoice_lines[0]).toMatchObject({
        label: "Consulting",
        raw_currency_unit_price: "100.00",
        vat_rate: "FR_200",
      });
    });
  });

  describe("update_invoice_draft", () => {
    it("re-reads the target, confirms it is a draft, then PUTs the update", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ id: 5, draft: true, status: "draft" }))
        .mockResolvedValueOnce(jsonResponse({ id: 5, draft: true, label: "Updated" }));
      const client = new PennylaneClient({ apiToken: "t" });

      const result = await client.updateInvoiceDraft({ id: 5, label: "Updated" });

      expect(result.invoice.label).toBe("Updated");
      // First call reads the target, second call writes.
      expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://app.pennylane.com/api/external/v2/customer_invoices/5",
      );
      const putCall = fetchSpy.mock.calls[1];
      expect(putCall?.[1]?.method).toBe("PUT");
      const body = JSON.parse(String(putCall?.[1]?.body));
      expect(body.draft).toBe(true);
      expect(body.label).toBe("Updated");
    });

    it("refuses to touch a finalized invoice and never issues the PUT", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ id: 9, draft: false, status: "upcoming" }));
      const client = new PennylaneClient({ apiToken: "t" });

      await expect(client.updateInvoiceDraft({ id: 9, label: "nope" })).rejects.toBeInstanceOf(
        PennylaneGuardRefusedError,
      );

      // Only the read happened; no PUT was issued.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
    });
  });

  describe("create_quote", () => {
    it("POSTs a quote (no draft/status field) and passes external_reference through (snake-cased)", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ id: 88, status: "pending" }));
      const client = new PennylaneClient({ apiToken: "t" });

      const result = await client.createQuote({
        customerId: 42,
        date: "2026-07-02",
        deadline: "2026-08-02",
        externalReference: "pipedrive-deal-4567",
        pdfInvoiceSubject: "Consulting proposal",
        invoiceLines: [
          { label: "Consulting fees", quantity: 2, unit: "day", rawCurrencyUnitPrice: "500.00", vatRate: "FR_200" },
        ],
      });

      expect(result.quote.id).toBe("88");
      expect(result.quote.status).toBe("pending");

      const call = fetchSpy.mock.calls[0];
      expect(call?.[1]?.method).toBe("POST");
      expect(String(call?.[0])).toBe("https://app.pennylane.com/api/external/v2/quotes");
      const body = JSON.parse(String(call?.[1]?.body));
      // Quotes have no draft/status field on create — it must NOT be sent.
      expect(body.draft).toBeUndefined();
      expect(body.status).toBeUndefined();
      expect(body.customer_id).toBe(42);
      expect(body.external_reference).toBe("pipedrive-deal-4567");
      expect(body.pdf_invoice_subject).toBe("Consulting proposal");
      expect(body.invoice_lines[0]).toMatchObject({
        label: "Consulting fees",
        raw_currency_unit_price: "500.00",
        vat_rate: "FR_200",
      });
    });
  });

  describe("update_quote", () => {
    it("re-reads the target, confirms it is pending, then PUTs the update with a lines diff", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ id: 7, status: "pending" }))
        .mockResolvedValueOnce(jsonResponse({ id: 7, status: "pending", label: "Updated" }));
      const client = new PennylaneClient({ apiToken: "t" });

      const result = await client.updateQuote({
        id: 7,
        label: "Updated",
        invoiceLines: {
          create: [{ label: "New line", quantity: 1, rawCurrencyUnitPrice: "10.00", vatRate: "FR_200" }],
          update: [{ id: 3, quantity: 5 }],
          delete: [4],
        },
      });

      expect(result.quote.label).toBe("Updated");
      // First call reads the target, second call writes.
      expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://app.pennylane.com/api/external/v2/quotes/7",
      );
      const putCall = fetchSpy.mock.calls[1];
      expect(putCall?.[1]?.method).toBe("PUT");
      const body = JSON.parse(String(putCall?.[1]?.body));
      expect(body.label).toBe("Updated");
      // invoice_lines is a diff object, snake-cased, not a flat array.
      expect(body.invoice_lines.create[0]).toMatchObject({ raw_currency_unit_price: "10.00" });
      expect(body.invoice_lines.update[0]).toMatchObject({ id: 3, quantity: 5 });
      expect(body.invoice_lines.delete).toEqual([4]);
    });

    it.each([
      ["accepted"],
      ["denied"],
      ["invoiced"],
      ["expired"],
      ["sent"],
    ])("refuses to touch a %s quote and never issues the PUT", async (status) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ id: 9, status }));
      const client = new PennylaneClient({ apiToken: "t" });

      await expect(client.updateQuote({ id: 9, label: "nope" })).rejects.toBeInstanceOf(
        PennylaneGuardRefusedError,
      );

      // Only the read happened; no PUT was issued.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
    });
  });
});
