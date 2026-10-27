import { afterEach, describe, expect, it, vi } from "vitest";
import { ZendeskClient } from "../client.js";
import { CreateArticleParamsSchema } from "../models.js";
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

describe("Zendesk Help Center", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists compact sections with sideloaded category names and cursor pagination", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      sections: [{ id: 10, name: "Getting started", source_locale: "en-us", category_id: 5, description: "Large" }],
      categories: [{ id: 5, name: "Documentation" }],
      meta: { after_cursor: "next", has_more: true },
    })));
    const result = await new ZendeskClient(baseOptions).listHelpCenterSections({ pageSize: 20, pageCursor: "before" });
    expect(result).toEqual({ sections: [{ id: 10, name: "Getting started", sourceLocale: "en-us", categoryId: 5, categoryName: "Documentation" }], nextPageCursor: "next", hasMore: true });
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/sections.json?page%5Bsize%5D=20&include=categories&page%5Bafter%5D=before");
  });
  it("narrows section discovery to one category", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sections: [], categories: [], meta: { has_more: false } })));
    expect(await new ZendeskClient(baseOptions).listHelpCenterSections({ categoryId: 5 })).toEqual({ sections: [], nextPageCursor: undefined, hasMore: false });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/categories/5/sections.json?page%5Bsize%5D=100&include=categories");
  });

  it("lists compact articles in one section including permissions and visibility", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      articles: [{ id: 7, title: "Start", locale: "en-us", draft: true, html_url: "https://acme.zendesk.com/hc/en-us/articles/7", permission_group_id: 42, user_segment_id: null, label_names: ["setup"], body: "<p>Large</p>", section_id: 10 }],
      meta: { after_cursor: "next", has_more: true },
    })));
    const result = await new ZendeskClient(baseOptions).listArticles({ sectionId: 10, pageSize: 30, pageCursor: "before" });
    expect(result).toEqual({ articles: [{ id: 7, title: "Start", locale: "en-us", draft: true, htmlUrl: "https://acme.zendesk.com/hc/en-us/articles/7", permissionGroupId: 42, userSegmentId: null, labelNames: ["setup"], sectionId: 10 }], nextPageCursor: "next", hasMore: true });
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/sections/10/articles.json?page%5Bsize%5D=30&page%5Bafter%5D=before");
  });

  it("requires the article destination and content and defaults new articles to draft", () => {
    const input = { sectionId: 10, title: "Start", body: "<p>Start</p>", locale: "en-us" };
    expect(CreateArticleParamsSchema.parse(input)).toEqual({ ...input, draft: true });
    for (const field of ["sectionId", "title", "body", "locale"]) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(CreateArticleParamsSchema.safeParse(missing).success, field).toBe(false);
    }
  });

  it("creates a draft with root notification control and omits an unset user segment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ article: { id: 7, title: "Start", locale: "en-us", draft: true, section_id: 10, permission_group_id: 42, user_segment_id: null, label_names: ["setup"], html_url: "https://acme.zendesk.com/hc/en-us/articles/7", body: "<p>Start</p>" } }), { status: 201 }));
    const result = await new ZendeskClient(baseOptions).createArticle({ sectionId: 10, title: "Start", body: "<p>Start</p>", locale: "en-us", labelNames: ["setup"], permissionGroupId: 42, notifySubscribers: false });
    expect(result).toEqual({ article: { id: 7, title: "Start", locale: "en-us", draft: true, sectionId: 10, permissionGroupId: 42, userSegmentId: null, labelNames: ["setup"], htmlUrl: "https://acme.zendesk.com/hc/en-us/articles/7" } });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/sections/10/articles.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ article: { title: "Start", body: "<p>Start</p>", locale: "en-us", label_names: ["setup"], permission_group_id: 42, draft: true }, notify_subscribers: false });
  });

  it("revises title, HTML and publication through the locale translation only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ translation: { id: 999, source_id: 7, title: "Revised", locale: "fr", draft: false, html_url: "https://acme.zendesk.com/hc/fr/articles/7", body: "<p>Revised</p>" } })));
    const result = await new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "fr", title: "Revised", body: "<p>Revised</p>", draft: false });
    expect(result).toEqual({ article: { id: 7, title: "Revised", locale: "fr", draft: false, htmlUrl: "https://acme.zendesk.com/hc/fr/articles/7" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/articles/7/translations/fr.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ translation: { title: "Revised", body: "<p>Revised</p>", draft: false } });
  });

  it("changes labels through article metadata only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ article: { id: 7, title: "Start", locale: "en-us", draft: true, label_names: [], html_url: "https://acme.zendesk.com/hc/en-us/articles/7", section_id: 10, permission_group_id: 42, user_segment_id: 6, body: "large" } })));
    expect(await new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "en-us", labelNames: [] })).toEqual({ article: { id: 7, title: "Start", locale: "en-us", draft: true, labelNames: [], htmlUrl: "https://acme.zendesk.com/hc/en-us/articles/7", sectionId: 10, permissionGroupId: 42, userSegmentId: 6 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/articles/7.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ article: { label_names: [] } });
  });

  it("combines translation changes with labels while returning translation presentation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ translation: { id: 999, source_id: 88, title: "Revised", locale: "fr", draft: false, html_url: "https://acme.zendesk.com/hc/fr/articles/7" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ article: { id: 7, title: "Stale English title", locale: "en-us", draft: true, html_url: "https://acme.zendesk.com/hc/en-us/articles/7", section_id: 10, permission_group_id: 42, user_segment_id: null, label_names: ["edited"] } })));
    expect(await new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "fr", title: "Revised", draft: false, labelNames: ["edited"] })).toEqual({ article: { id: 7, title: "Revised", locale: "fr", draft: false, htmlUrl: "https://acme.zendesk.com/hc/fr/articles/7", sectionId: 10, permissionGroupId: 42, userSegmentId: null, labelNames: ["edited"] } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/articles/7/translations/fr.json");
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/articles/7.json");
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ translation: { title: "Revised", draft: false } });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ article: { label_names: ["edited"] } });
  });

  it("reports a saved translation when the subsequent label update fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ translation: { title: "Saved", locale: "en-us", draft: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Labels unavailable on this plan" }), { status: 400 }));
    await expect(new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "en-us", title: "Saved", labelNames: ["edited"] })).rejects.toThrow(/Article 7 translation.*saved.*labels.*failed.*Labels unavailable/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([403, 422])("explains Help Center write rights for status %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Publishing denied" }), { status }));
    await expect(new ZendeskClient(baseOptions).createArticle({ sectionId: 10, title: "Start", body: "<p>Start</p>", locale: "en-us", draft: false, permissionGroupId: 42 })).rejects.toThrow(/connected user lacks Help Center rights.*create, edit, or publish.*permission group.*draft: true.*Publishing denied/);
  });

  it.each([403, 422])("explains Help Center rights when an article update returns %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Publishing denied" }), { status }));
    await expect(new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "en-us", draft: false })).rejects.toThrow(/connected user lacks Help Center rights.*Publishing denied/);
  });

  it("keeps the authentication error for a 403 on a ticket update", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));
    const result = new ZendeskClient(baseOptions).updateTicket({ ticketId: 7, status: "pending" });
    await expect(result).rejects.toBeInstanceOf(ZendeskAuthError);
    await expect(result).rejects.not.toThrow(/Help Center rights/);
  });

  it("does not use the Help Center rights error for a 422 on a ticket update", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Invalid status" }), { status: 422 }));
    await expect(new ZendeskClient(baseOptions).updateTicket({ ticketId: 7, status: "pending" })).rejects.not.toThrow(/Help Center rights/);
  });

  it("archives a draft article with GET then an empty 204 DELETE", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ article: { id: 7, title: "Old draft", draft: true } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await new ZendeskClient(baseOptions).archiveArticle({ articleId: 7 })).toEqual({ archived: true, articleId: 7, title: "Old draft" });
    expect(fetchSpy.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "DELETE"]);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe("https://acme.zendesk.com/api/v2/help_center/articles/7.json");
  });

  it("refuses to archive a published article and sends no DELETE", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ article: { id: 7, title: "Live", draft: false } })));
    await expect(new ZendeskClient(baseOptions).archiveArticle({ articleId: 7 })).rejects.toThrow(/published.*Only draft articles can be archived.*Guide admin/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    ["null", { id: 7, title: "Unknown", draft: null }],
    ["absent", { id: 7, title: "Unknown" }],
  ])("refuses to archive an article with a %s draft state and sends no DELETE", async (_label, article) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ article })));
    await expect(new ZendeskClient(baseOptions).archiveArticle({ articleId: 7 })).rejects.toThrow(/Only draft articles can be archived/);
    expect(fetchSpy.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
  });

  it("maps a 403 on the GET to the Help Center rights error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));
    await expect(new ZendeskClient(baseOptions).archiveArticle({ articleId: 7 })).rejects.toThrow(/connected user lacks Help Center rights.*Forbidden/);
  });

  it("maps a 403 on the DELETE to the Help Center rights error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ article: { id: 7, title: "Old draft", draft: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Archive denied" }), { status: 403 }));
    await expect(new ZendeskClient(baseOptions).archiveArticle({ articleId: 7 })).rejects.toThrow(/connected user lacks Help Center rights.*Archive denied/);
  });

  it("rejects an article update without fields before sending a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected HTTP request"));
    await expect(new ZendeskClient(baseOptions).updateArticle({ articleId: 7, locale: "en-us" })).rejects.toThrow("update_article needs at least one field to change");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});
