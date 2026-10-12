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
  it("defaults to read-only and exposes six writes only when enabled", () => {
    const names = (merged: Record<string, unknown>) => extension.createTools({ global: {}, agent: {}, merged }).map((tool) => tool.name);
    expect(names({})).toEqual(["list_files", "search_files", "read_file", "sheets_list_spreadsheets", "sheets_inspect", "sheets_read_sheet", "sheets_read_range", "validate"]);
    expect(names({ allowWrite: false })).toEqual(names({}));
    expect(names({ allowWrite: true })).toEqual([...names({}), "create_folder", "create_file", "update_file_content", "rename_move_file", "sheets_update_range", "sheets_append_rows"]);
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
    expect(prompts!.join("\n").includes("googleDrive_create_file")).toBe(expectedWrite);
  });

  it("preserves the host insufficient_scope reconnect link", async () => {
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: false, provider: "google", reason: "insufficient_scope", message: "Reconnect", authorizeUrl: "/authorize?scopes=write",
    } });
    await expect(tools.find((tool) => tool.name === "create_file")!.execute({ name: "Clients", content: "" })).resolves.toMatchObject({ reason: "insufficient_scope", authorizeUrl: "/authorize?scopes=write" });
  });

  it("turns API permission refusals into insufficient_scope", async () => {
    stubDriveFailure(403, "permission denied");
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: true, provider: "google", accessToken: "token", scopes: [],
    } });
    await expect(tools.find((tool) => tool.name === "create_folder")!.execute({ name: "Clients" })).resolves.toMatchObject({ reason: "insufficient_scope" });
  });

  it.each([
    [401, "", "expired", "Google access has expired. Reconnect Google to continue."],
    [429, "", "rate_limited", "Google Drive is temporarily rate limited. Wait and retry."],
    [403, "userRateLimitExceeded quota", "rate_limited", "Google Drive is temporarily rate limited. Wait and retry."],
    [403, "forbidden", "insufficient_scope", "Google Drive needs additional Google permission. Reconnect Google and approve the configured access."],
  ])("maps API status %s (%s) to %s", async (status, body, reason, message) => {
    stubDriveFailure(status, body);
    const tools = extension.createTools({ global: {}, agent: {}, merged: { allowWrite: true }, oauth: {
      connected: true, provider: "google", accessToken: "token", scopes: [],
    } });
    await expect(tools.find((tool) => tool.name === "create_folder")!.execute({ name: "Clients" })).resolves.toEqual({ connected: false, provider: "google", reason, message });
  });
});
