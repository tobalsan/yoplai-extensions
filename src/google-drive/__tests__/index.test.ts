import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "../index.js";
import { GoogleDriveClient } from "../client.js";
import type { ResolvedOAuth } from "../../tool-extension.js";

// Fails every Drive HTTP call; retry-after 0 keeps 429 retries instant.
function stubDriveFailure(status: number, body: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "retry-after": "0" } })));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("googleDrive extension", () => {
  it("keeps authentication, pagination, and write guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { googleDrive: {} } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Tools:");
    expect(prompt).not.toMatch(/^- googleDrive_\w+:/m);
    expect(prompt).toContain("requester's own Google connection");
    expect(prompt).toContain("pageSize and pageToken");
    expect(prompt).toContain("rowOffset, maxRows, and columns");
    expect(prompt).toContain("Before writing, read the target tab or range");
    expect(prompt).toContain("report the updated range and cell count");
  });

  it("exports the expected extension contract with an oauth requirement", () => {
    expect(extension.id).toBe("googleDrive");
    expect(extension.displayName).toBe("Google Drive");
    expect(extension.requiredSecrets).toEqual([]);
    expect(typeof extension.oauth === "function" ? extension.oauth({ global: {}, agent: {}, merged: {} }) : extension.oauth).toEqual({
      provider: "google",
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    });
  });

  it("validate returns connected using the injected fresh token", async () => {
    const aboutSpy = vi
      .spyOn(GoogleDriveClient.prototype, "about")
      .mockResolvedValue({
        displayName: "Alice Example",
        emailAddress: "alice@example.com",
      });

    const connected: ResolvedOAuth = {
      connected: true,
      provider: "google",
      accessToken: "fresh-access-token",
      account: "alice@example.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    };

    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: {},
      oauth: connected,
    });
    const validate = tools.find((tool) => tool.name === "validate");
    expect(validate).toBeDefined();

    const result = await validate!.execute({});
    expect(result).toMatchObject({
      connected: true,
      provider: "google",
      account: "alice@example.com",
      displayName: "Alice Example",
    });
    expect(aboutSpy).toHaveBeenCalledOnce();
  });

  it("validate returns the documented not-connected signal (no raw 401)", async () => {
    const notConnected: ResolvedOAuth = {
      connected: false,
      provider: "google",
      reason: "not_connected",
      message: "Google Drive is not connected for agent \"a1\".",
      authorizeUrl: "http://localhost:4000/api/oauth/google/authorize?agent=a1",
    };

    const tools = extension.createTools({
      global: {},
      agent: {},
      merged: {},
      oauth: notConnected,
    });
    const validate = tools.find((tool) => tool.name === "validate")!;

    const result = await validate.execute({});
    expect(result).toEqual({
      isError: true,
      connected: false,
      provider: "google",
      reason: "not_connected",
      message: 'Google Drive is not connected for agent "a1".',
      authorizeUrl: "http://localhost:4000/api/oauth/google/authorize?agent=a1",
    });
  });

  it("getAgentTools injects the resolved token from the host resolveOAuth hook", async () => {
    const resolveOAuth = vi.fn(async () => ({
      connected: true as const,
      provider: "google",
      accessToken: "hook-token",
      account: "bob@example.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    }));

    const aboutSpy = vi
      .spyOn(GoogleDriveClient.prototype, "about")
      .mockResolvedValue({ emailAddress: "bob@example.com" });

    const agent = { id: "a1", extensions: { googleDrive: {} } };
    const tools = await extension.getAgentTools(agent, {
      config: { extensions: {} },
      resolveOAuth,
    });
    const validate = tools.find((tool) => tool.name === "googleDrive_validate");
    expect(validate).toBeDefined();

    const result = await validate!.execute({});
    expect(resolveOAuth).toHaveBeenCalledWith(agent, typeof extension.oauth === "function" ? extension.oauth({ global: {}, agent: {}, merged: {} }) : extension.oauth, undefined);
    expect(result).toMatchObject({ connected: true, account: "bob@example.com" });
    expect(aboutSpy).toHaveBeenCalled();
  });

  it("getAgentTools surfaces not-connected when the host has no resolver", async () => {
    const tools = await extension.getAgentTools(
      { id: "a1", extensions: { googleDrive: {} } },
      { config: { extensions: {} } }
    );
    const validate = tools.find((tool) => tool.name === "googleDrive_validate")!;
    const result = (await validate.execute({})) as { connected: boolean; reason: string };
    expect(result.connected).toBe(false);
    expect(result.reason).toBe("provider_not_configured");
  });
});


describe("write mode", () => {
  it("defaults to read-only and exposes seven writes only when enabled", () => {
    const names = (merged: Record<string, unknown>) => extension.createTools({ global: {}, agent: {}, merged }).map((tool) => tool.name);
    expect(names({})).toEqual(["list_files", "search_files", "read_file", "download_file", "sheets_list_spreadsheets", "sheets_inspect", "sheets_read_sheet", "sheets_read_range", "validate"]);
    expect(names({ allowWrite: false })).toEqual(names({}));
    expect(names({ allowWrite: true })).toEqual([...names({}), "save_file", "create_folder", "create_file", "update_file_content", "rename_move_file", "sheets_update_range", "sheets_append_rows"]);
    expect(extension.configJsonSchema).toMatchObject({ properties: { allowWrite: { type: "boolean", default: false, title: "Enable creating and writing files" } } });
  });

  it.each([[true, false, false], [false, true, true]])("agent override beats root (%s / %s)", async (rootWrite, agentWrite, expectedWrite) => {
    const resolveOAuth = vi.fn(async (_agent: { id: string }, _requirement: import("../../tool-extension.js").OAuthRequirement) => ({ connected: false as const, provider: "google", reason: "not_connected" as const, message: "Connect Google" }));
    const agent = { id: "a1", extensions: { googleDrive: { allowWrite: agentWrite } } };
    const context = { config: { extensions: { googleDrive: { allowWrite: rootWrite } } }, resolveOAuth };
    const tools = await extension.getAgentTools(agent, context);
    expect(tools.some((tool) => tool.name === "googleDrive_create_file")).toBe(expectedWrite);
    const scopes = resolveOAuth.mock.calls[0][1].scopes;
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      ...(expectedWrite ? ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets"] : []),
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    await tools[0].execute({});
    expect(resolveOAuth).toHaveBeenCalledTimes(2);
    expect(resolveOAuth.mock.calls[1][1]).toEqual(resolveOAuth.mock.calls[0][1]);
    const prompts = await extension.getSystemPromptContributions(agent, context);
    expect(prompts!.join("\n")).toContain("Write tools are available only when allowWrite is enabled");
    expect(prompts!.join("\n")).not.toContain("googleDrive_create_file:");
  });

  it("preserves the host insufficient_scope reconnect link", async () => {
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: false, provider: "google", reason: "insufficient_scope", message: "Reconnect", authorizeUrl: "/authorize?scopes=write",
    } });
    await expect(tools.find((tool) => tool.name === "create_file")!.execute({ name: "Clients", content: "" })).resolves.toMatchObject({ reason: "insufficient_scope", authorizeUrl: "/authorize?scopes=write" });
  });

  it("turns API OAuth scope refusals into insufficient_scope", async () => {
    stubDriveFailure(403, "insufficientPermissions");
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: true, provider: "google", accessToken: "token", scopes: [],
    } });
    await expect(tools.find((tool) => tool.name === "create_folder")!.execute({ name: "Clients" })).resolves.toMatchObject({ reason: "insufficient_scope" });
  });

  it.each([
    [401, "", "expired", { connected: false, provider: "google", reason: "expired", message: "Google access has expired. Reconnect Google to continue.", isError: true }],
    [429, "", "rate_limited", { connected: false, provider: "google", reason: "rate_limited", message: "Google Drive is temporarily rate limited. Wait and retry." }],
    [403, "userRateLimitExceeded quota", "rate_limited", { connected: false, provider: "google", reason: "rate_limited", message: "Google Drive is temporarily rate limited. Wait and retry." }],
    [403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficient_scope", { connected: false, provider: "google", reason: "insufficient_scope", message: "Google Drive needs additional Google permission. Reconnect Google and approve the configured access.", isError: true }],
  ])("maps API status %s (%s) to %s", async (status, body, _reason, expected) => {
    stubDriveFailure(status, body);
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: true, provider: "google", accessToken: "token", scopes: [],
    } });
    await expect(tools.find((tool) => tool.name === "create_folder")!.execute({ name: "Clients" })).resolves.toEqual(expected);
  });
});

it("declares search metadata and extracted-file result fields", async () => {
  const tools = extension.createTools({ global: {}, agent: {}, merged: {} });
  const examples: Record<string, unknown[]> = {
    search_files: [{ files: [{ id: "doc1", name: "Report", mimeType: "text/plain", modifiedTime: null, size: 12, webViewLink: null }], nextPageToken: "page2" }, { files: [], nextPageToken: null }],
    read_file: [{ fileId: "doc1", name: "Report", mimeType: null, text: "Quarterly report", bytes: 16, exported: false }, { fileId: "doc2", name: "Google Doc", mimeType: "application/vnd.google-apps.document", text: "Text", bytes: 4, exported: true }],
  };
  const mounted = await extension.getAgentTools({ id: "a", extensions: { googleDrive: {} } }, { config: {} });
  for (const [name, fixtures] of Object.entries(examples)) {
    const schema = tools.find((tool) => tool.name === name)!.outputSchema;
    expect(schema, name).toBeDefined();
    for (const fixture of fixtures) expect(schema!.safeParse(fixture).success).toBe(true);
    expect(mounted.find((tool) => tool.name === `googleDrive_${name}`)).toHaveProperty("outputSchema.type", "object");
  }
});
