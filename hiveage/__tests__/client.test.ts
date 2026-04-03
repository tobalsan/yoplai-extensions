import { afterEach, describe, expect, it, vi } from "vitest";
import { HiveageClient } from "../client.js";
import {
  HiveageAuthError,
  HiveageNotFoundError,
  HiveageRateLimitError,
} from "../errors.js";

describe("HiveageClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends basic auth header and snake_case JSON body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          invoice: {
            id: 1,
            hash_key: "inv_1",
            statement_no: "IN-001",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new HiveageClient({ apiKey: "secret", subdomain: "acme" });

    const result = await client.createInvoice({
      connectionId: 10,
      date: "2026-04-03",
      dueDate: "2026-04-10",
      statementNo: "IN-001",
      sendReminders: true,
    });

    expect(result.invoice.hashKey).toBe("inv_1");
    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("secret:").toString("base64")}`,
    });
    expect(request?.body).toBe(
      JSON.stringify({
        invoice: {
          connection_id: 10,
          date: "2026-04-03",
          due_date: "2026-04-10",
          statement_no: "IN-001",
          send_reminders: true,
        },
      }),
    );
  });

  it("maps 404 to HiveageNotFoundError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new HiveageClient({ apiKey: "secret", subdomain: "acme" });

    await expect(client.getInvoice({ hashKey: "missing" })).rejects.toBeInstanceOf(HiveageNotFoundError);
  });

  it("maps 401 to HiveageAuthError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad auth" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new HiveageClient({ apiKey: "secret", subdomain: "acme" });

    await expect(client.listInvoices({})).rejects.toBeInstanceOf(HiveageAuthError);
  });

  it("retries rate limits and respects pagination params", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [{ id: 1, hash_key: "inv_1", statement_no: "IN-001" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new HiveageClient({ apiKey: "secret", subdomain: "acme" });

    const result = await client.listInvoices({ perPage: 60, page: 2, order: "desc" });

    expect(result.invoices).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://acme.hiveage.com/api/invs?per_page=60&page=2&order=desc",
    );
  });

  it("throws rate limit error after exhausting retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      }),
    );
    const client = new HiveageClient({ apiKey: "secret", subdomain: "acme" });

    await expect(client.listInvoices({})).rejects.toBeInstanceOf(HiveageRateLimitError);
  });
});
