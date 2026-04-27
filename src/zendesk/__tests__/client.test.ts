import { afterEach, describe, expect, it, vi } from "vitest";
import { ZendeskClient } from "../client.js";
import {
  ZendeskAuthError,
  ZendeskNotFoundError,
  ZendeskRateLimitError,
} from "../errors.js";

const baseOptions = {
  subdomain: "acme",
  email: "agent@acme.com",
  apiKey: "secret",
};

const expectedAuth = `Basic ${Buffer.from("agent@acme.com/token:secret").toString("base64")}`;

describe("ZendeskClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends basic auth header with email/token format", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          tickets: [{ id: 1, subject: "Hi", status: "open" }],
          meta: { after_cursor: "abc", has_more: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new ZendeskClient(baseOptions);

    const result = await client.listTickets({ pageSize: 50 });

    expect(result.tickets).toHaveLength(1);
    expect(result.nextPageCursor).toBe("abc");
    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: expectedAuth });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://acme.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=50&sort=-id",
    );
  });

  it("maps 404 to ZendeskNotFoundError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ZendeskClient(baseOptions);

    await expect(client.getTicket({ ticketId: 9999 })).rejects.toBeInstanceOf(
      ZendeskNotFoundError,
    );
  });

  it("maps 401 to ZendeskAuthError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad auth" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ZendeskClient(baseOptions);

    await expect(client.listTickets({})).rejects.toBeInstanceOf(ZendeskAuthError);
  });

  it("retries 429 then succeeds", async () => {
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
          JSON.stringify({ tickets: [{ id: 1, subject: "Hi", status: "open" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new ZendeskClient(baseOptions);

    const result = await client.listTickets({});

    expect(result.tickets).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws ZendeskRateLimitError after exhausting retries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      }),
    );
    const client = new ZendeskClient(baseOptions);

    await expect(client.listTickets({})).rejects.toBeInstanceOf(ZendeskRateLimitError);
  });
});
