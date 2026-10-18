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
  });

  it("creates 7 tools", () => {
    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: { subdomain: "acme", email: "agent@acme.com", apiKey: "secret" },
    });

    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_tickets",
      "search_tickets",
      "get_ticket",
      "update_ticket",
      "add_internal_note",
      "list_groups",
      "list_agents",
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
    const requirement = { provider: "zendesk", scopes: ["read", "tickets:write"] };
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
    ] as const) {
      expect(await tool.execute(params, {})).toEqual({
        connected: false,
        provider: "zendesk",
        reason: "not_connected",
        message: "Zendesk is not connected",
        authorizeUrl: "https://gw/api/oauth/zendesk/authorize?agent=a1",
      });
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
      scopes: ["read", "tickets:write"],
      apiBaseUrl: "https://acme.zendesk.com",
    });
    await tools[0].execute({}, { userId: "alice" });
    expect(resolveOAuth).toHaveBeenLastCalledWith(
      agent,
      { provider: "zendesk", scopes: ["read", "tickets:write"] },
      "alice",
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("https://acme.zendesk.com/api/v2/tickets.json");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});
