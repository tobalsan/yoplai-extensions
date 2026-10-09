import { afterEach, describe, expect, it, vi } from "vitest";
import { ZendeskClient } from "../client.js";
import {
  ZendeskAuthError,
  ZendeskNotFoundError,
  ZendeskRateLimitError,
  ZendeskValidationError,
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

  it("updates triage fields with a snake_case PUT body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ticket: { id: 7, status: "pending", priority: "high" } }), { status: 200 }),
    );
    const client = new ZendeskClient(baseOptions);

    const result = await client.updateTicket({
      ticketId: "7",
      status: "pending",
      priority: "high",
      assigneeId: 42,
      groupId: 9,
      addTags: ["billing"],
      removeTags: ["triage_needed"],
    });

    expect(result.ticket.status).toBe("pending");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/tickets/7.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ticket: {
        status: "pending",
        priority: "high",
        assignee_id: 42,
        group_id: 9,
        additional_tags: ["billing"],
        remove_tags: ["triage_needed"],
      },
    });
  });

  it("rejects an update with no fields and status values the API cannot set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ZendeskClient(baseOptions);

    await expect(client.updateTicket({ ticketId: 7 })).rejects.toBeInstanceOf(ZendeskValidationError);
    await expect(client.updateTicket({ ticketId: 7, status: "closed" })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adds an internal note as a private comment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ticket: { id: 7 } }), { status: 200 }),
    );
    const client = new ZendeskClient(baseOptions);

    await client.addInternalNote({ ticketId: 7, body: "Escalated to billing" });

    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ticket: { comment: { body: "Escalated to billing", public: false } },
    });
  });

  it("lists groups with cursor pagination", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          groups: [{ id: 9, name: "Billing", default: false, deleted: false, url: "https://x" }],
          meta: { after_cursor: "next", has_more: true },
        }),
        { status: 200 },
      ),
    );
    const client = new ZendeskClient(baseOptions);

    const result = await client.listGroups({ pageCursor: "abc" });

    expect(result).toEqual({
      groups: [{ id: 9, name: "Billing", default: false, deleted: false }],
      nextPageCursor: "next",
      hasMore: true,
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://acme.zendesk.com/api/v2/groups.json?page%5Bsize%5D=100&page%5Bafter%5D=abc",
    );
  });

  it("lists agents and admins, optionally scoped to a group", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          users: [{ id: 42, name: "Ana", email: "ana@x.co", role: "agent", default_group_id: 9, photo: null }],
        }),
        { status: 200 },
      ),
    );
    const client = new ZendeskClient(baseOptions);

    const all = await client.listAgents({});
    await client.listAgents({ groupId: 9, pageSize: 10 });

    expect(all.agents).toEqual([{ id: 42, name: "Ana", email: "ana@x.co", role: "agent", defaultGroupId: 9 }]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://acme.zendesk.com/api/v2/users.json?page%5Bsize%5D=100&role%5B%5D=agent&role%5B%5D=admin",
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://acme.zendesk.com/api/v2/groups/9/users.json?page%5Bsize%5D=10&role%5B%5D=agent&role%5B%5D=admin",
    );
  });

  it("sends a bearer token against the given base URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tickets: [] }), { status: 200 }),
    );
    const client = new ZendeskClient({ accessToken: "tok", baseUrl: "https://acme.zendesk.com/" });

    await client.listTickets({});

    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/^https:\/\/acme\.zendesk\.com\/api\/v2\/tickets\.json/);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});
