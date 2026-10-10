import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { NotionConfigSchema } from "../models.js";

describe("notion extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("notion");
    expect(extension.displayName).toBe("Notion");
    expect(extension.description).toContain("Notion");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
  });

  it("parses config defaults", () => {
    expect(
      NotionConfigSchema.parse({
        mode: "api_key",
        apiKey: "secret",
      }),
    ).toEqual({
      mode: "api_key",
      apiKey: "secret",
      notionVersion: "2026-03-11",
      timeoutMs: 30_000,
    });
  });

  function createTools() {
    return extension.createTools({
      global: {},
      agent: {},
      merged: {
        mode: "api_key",
        apiKey: "secret",
      },
    });
  }

  it("creates the expected tools with object parameter schemas", () => {
    const tools = createTools();

    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_data_sources",
      "list_pages",
      "search_pages",
      "get_data_source",
      "update_data_source",
      "query_data_source",
      "get_page",
      "get_page_markdown",
      "create_page",
      "update_page_properties",
      "update_page_markdown",
      "get_blocks",
      "append_blocks",
      "delete_block",
      "replace_child_blocks",
      "download_and_extract_file",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("returns structured extraction errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ExpiredToken", { status: 403 }));
    const tool = createTools().find(({ name }) => name === "download_and_extract_file");

    await expect(tool?.execute({ url: "https://example.com/cv.pdf?signature=expired" })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "SIGNED_URL_EXPIRED", status: 403, retryable: false }),
    });
  });
});

describe("notion extension modes", () => {
  const mount = async (agentConfig: Record<string, unknown>, oauth?: unknown) => {
    const resolveOAuth = vi.fn(async () => oauth as never);
    const agent = { id: "a1", extensions: { notion: { enabled: true, ...agentConfig } } };
    const tools = await extension.getAgentTools(agent, { config: { extensions: {} }, resolveOAuth });
    return { tools, resolveOAuth, agent };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares an oauth requirement unless mode is api_key (oauth is the default)", () => {
    const oauth = extension.oauth as (config: { global: object; agent: object; merged: object }) => unknown;
    expect(oauth({ global: {}, agent: {}, merged: {} })).toEqual({ provider: "notion" });
    expect(oauth({ global: {}, agent: {}, merged: { mode: "api_key" } })).toBeUndefined();
  });

  it("requires apiKey only in api_key mode", () => {
    expect(NotionConfigSchema.safeParse({ mode: "api_key" }).success).toBe(false);
    expect(NotionConfigSchema.parse({}).mode).toBe("oauth");
  });

  it("api_key mode works without calling the OAuth host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { tools, resolveOAuth } = await mount({ mode: "api_key", apiKey: "k" });
    await tools.find((tool) => tool.name.endsWith("validate"))!.execute({}, { userId: "alice" });
    expect(resolveOAuth).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("oauth mode returns the structured not-connected result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const notConnected = {
      connected: false,
      provider: "notion",
      reason: "not_connected",
      message: "Notion is not connected",
      authorizeUrl: "https://gw/api/oauth/notion/authorize?agent=a1",
    };
    const { tools } = await mount({}, notConnected);
    for (const tool of tools) {
      expect(await tool.execute({}, {})).toEqual(notConnected);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("oauth mode calls the API with the bearer token when connected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { tools, resolveOAuth, agent } = await mount({}, {
      connected: true,
      provider: "notion",
      accessToken: "tok",
      scopes: [],
    });
    await tools.find((tool) => tool.name.endsWith("validate"))!.execute({}, { userId: "alice" });
    expect(resolveOAuth).toHaveBeenLastCalledWith(agent, { provider: "notion" }, "alice");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.notion.com/v1/users/me");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});
