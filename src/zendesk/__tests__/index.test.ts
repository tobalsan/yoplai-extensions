import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";
import extension from "../index.js";
import { ZendeskConfigSchema } from "../models.js";

describe("zendesk extension", () => {
  it("keeps pagination, triage, and credential guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { zendesk: {} } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toMatch(/^- zendesk_\w+:/m);
    expect(prompt).toContain("follow nextPageCursor across pages");
    expect(prompt).toContain("pageSize up to 100");
    expect(prompt).toContain("Only the fields you pass change");
    expect(prompt).toContain("Internal notes are visible to agents only");
    expect(prompt).toContain("read the ticket first");
    expect(prompt).toContain("never guess them");
    expect(prompt).toContain("share the connect link it returns");
    expect(extension.description).toContain("Help Center articles");
    expect(prompt).toContain("zendesk_list_help_center_sections");
    expect(prompt).toContain("zendesk_list_articles");
    expect(prompt).toContain("source locale");
    expect(prompt).toContain("draft by default");
    expect(prompt).toContain("publish only on explicit request");
    expect(prompt).toContain("zendesk_update_article");
    expect(prompt).toMatch(/archive only draft/i);
    expect(prompt).toMatch(/ask the user before you archive/i);
    expect(prompt).toMatch(/no articles.*same category/is);
    expect(prompt).toContain("Never omit `permissionGroupId`");
    expect(prompt).toMatch(/more than one permission group.*most articles use/is);
    expect(prompt).toMatch(/same count.*ask which one to use/is);
  });

  it("creates 12 tools", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { subdomain: "acme", email: "agent@acme.com", apiKey: "secret" },
    });

    expect(tools).toHaveLength(12);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_tickets",
      "search_tickets",
      "get_ticket",
      "update_ticket",
      "add_internal_note",
      "list_groups",
      "list_agents",
      "list_help_center_sections",
      "list_articles",
      "create_article",
      "update_article",
      "archive_article",
    ]);
  });

  it("rejects subdomains that can redirect API credentials", () => {
    expect(() =>
      extension.createTools({
        global: {},
        agent: {},
        merged: {
          subdomain: "account@attacker.example/",
          email: "agent@acme.com",
          apiKey: "secret",
        },
      }),
    ).toThrow();
  });

  it("uses z.object parameter schemas", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { subdomain: "acme", email: "agent@acme.com", apiKey: "secret" },
    });

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });
});

describe("zendesk extension modes", () => {
  const mount = async (agentConfig: Record<string, unknown>, oauth?: unknown) => {
    const resolveOAuth = vi.fn(async () => oauth as never);
    const agent = { id: "a1", extensions: { zendesk: { enabled: true, ...agentConfig } } };
    const tools = await extension.getAgentTools(agent, {
      config: { extensions: {} },
      resolveOAuth,
    });
    return { tools, resolveOAuth, agent };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares an oauth requirement unless mode is api_key (oauth is the default)", () => {
    const oauth = extension.oauth as (config: { global: object; agent: object; merged: object }) => unknown;
    const requirement = { provider: "zendesk", scopes: ["read", "tickets:write", "hc:read", "hc:write"] };
    expect(oauth({ global: {}, agent: {}, merged: { mode: "oauth" } })).toEqual(requirement);
    expect(oauth({ global: {}, agent: {}, merged: {} })).toEqual(requirement);
    expect(oauth({ global: {}, agent: {}, merged: { mode: "api_key" } })).toBeUndefined();
  });

  it("still requires subdomain, email and apiKey in api_key mode", () => {
    expect(ZendeskConfigSchema.safeParse({ mode: "api_key" }).success).toBe(false);
    const result = ZendeskConfigSchema.safeParse({ mode: "api_key", subdomain: "acme" });
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path[0])).toEqual(["email", "apiKey"]);
    expect(ZendeskConfigSchema.safeParse({ mode: "api_key", subdomain: "acme", email: "a@b.co", apiKey: "k" }).success).toBe(true);
  });

  it("needs no subdomain, email or apiKey in oauth mode (the default)", () => {
    expect(ZendeskConfigSchema.safeParse({ mode: "oauth" }).success).toBe(true);
    expect(ZendeskConfigSchema.parse({}).mode).toBe("oauth");
  });

  it("api_key mode works without calling the OAuth host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tickets: [] }), { status: 200 }),
    );
    const { tools, resolveOAuth } = await mount({ mode: "api_key", subdomain: "acme", email: "a@b.co", apiKey: "k" });
    await tools[0].execute({}, { userId: "alice" });
    expect(resolveOAuth).not.toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("https://acme.zendesk.com/api/v2/tickets.json");
    expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("creates a Help Center draft with existing API-key credentials", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ article: { id: 21, title: "Setup", locale: "en-us", draft: true, html_url: "https://acme.zendesk.com/hc/en-us/articles/21", body: "<p>Steps</p>" } }), { status: 201 }),
    );
    const { tools, resolveOAuth } = await mount({ mode: "api_key", subdomain: "acme", email: "a@b.co", apiKey: "k" });
    const tool = tools.find((tool) => tool.name === "zendesk_create_article")!;
    expect(await tool.execute({ sectionId: 10, title: "Setup", body: "<p>Steps</p>", locale: "en-us", permissionGroupId: 30, notifySubscribers: false }, {})).toEqual({
      article: { id: 21, title: "Setup", locale: "en-us", draft: true, htmlUrl: "https://acme.zendesk.com/hc/en-us/articles/21" },
    });
    expect(resolveOAuth).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Basic YUBiLmNvL3Rva2VuOms=" });
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      article: { title: "Setup", body: "<p>Steps</p>", locale: "en-us", permission_group_id: 30, draft: true },
      notify_subscribers: false,
    });
  });

  it("oauth mode returns the structured not-connected result for every tool", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { tools } = await mount({ mode: "oauth" }, {
      connected: false,
      provider: "zendesk",
      reason: "not_connected",
      message: "Zendesk is not connected",
      authorizeUrl: "https://gw/api/oauth/zendesk/authorize?agent=a1",
    });
    for (const [tool, params] of [
      [tools[0], {}],
      [tools[1], { query: "x" }],
      [tools[2], { ticketId: 1 }],
      [tools[3], { ticketId: 1, status: "open" }],
      [tools[4], { ticketId: 1, body: "note" }],
      [tools[5], {}],
      [tools[6], { groupId: 1 }],
      [tools[7], {}],
      [tools[8], { sectionId: 10 }],
      [tools[9], { sectionId: 10, title: "Setup", body: "<p>Steps</p>", locale: "en-us" }],
      [tools[10], { articleId: 20, locale: "en-us", draft: false }],
      [tools[11], { articleId: 20 }],
    ] as const) {
      expect(await tool.execute(params, {})).toEqual({
        isError: true,
        connected: false,
        provider: "zendesk",
        reason: "not_connected",
        message: "Zendesk is not connected",
        authorizeUrl: "https://gw/api/oauth/zendesk/authorize?agent=a1",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["insufficient_scope", "needs_reconnect"])("Help Center tools preserve %s and the reconnect link", async (reason) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const refusal = {
      connected: false,
      provider: "zendesk",
      reason,
      message: "Reconnect Zendesk to grant Help Center scopes",
      authorizeUrl: "https://gw/api/oauth/zendesk/authorize?agent=a1",
    };
    const { tools } = await mount({}, refusal);
    for (const tool of tools.filter((tool) => [
      "zendesk_list_help_center_sections", "zendesk_list_articles", "zendesk_create_article", "zendesk_update_article", "zendesk_archive_article",
    ].includes(tool.name))) {
      expect(await tool.execute({}, {})).toEqual({ isError: true, ...refusal });
      expect(tool.outputSchema).toHaveProperty("type", "object");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("oauth mode calls the API with the bearer token and apiBaseUrl when connected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tickets: [] }), { status: 200 }),
    );
    const { tools, resolveOAuth, agent } = await mount({ mode: "oauth" }, {
      connected: true,
      provider: "zendesk",
      accessToken: "tok",
      scopes: ["read", "tickets:write", "hc:read", "hc:write"],
      apiBaseUrl: "https://acme.zendesk.com",
    });
    await tools[0].execute({}, { userId: "alice" });
    expect(resolveOAuth).toHaveBeenLastCalledWith(
      agent,
      { provider: "zendesk", scopes: ["read", "tickets:write", "hc:read", "hc:write"] },
      "alice",
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("https://acme.zendesk.com/api/v2/tickets.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});

it("declares ticket result envelopes with comments, attachments and optional pagination", async () => {
  const tools = extension.createTools({ global: {}, agent: {}, merged: {} });
  const ticket = { id: 42, subject: "Billing", status: "open", comments: [{ id: 7, body: "Invoice attached", attachments: [{ id: 9, fileName: "invoice.pdf", size: 100 }] }] };
  for (const [name, examples] of [
    ["get_ticket", [{ ticket }]],
    ["search_tickets", [{ tickets: [ticket], count: 1, nextPage: "https://example.test/page/2" }, { tickets: [] }]],
  ] as const) {
    const schema = tools.find((tool) => tool.name === name)!.outputSchema;
    expect(schema, name).toBeDefined();
    for (const fixture of examples) expect(schema!.safeParse(fixture).success).toBe(true);
    const mounted = await extension.getAgentTools({ id: "a", extensions: { zendesk: {} } }, { config: {} });
    expect(mounted.find((tool) => tool.name === `zendesk_${name}`)).toHaveProperty("outputSchema.type", "object");
  }
});
