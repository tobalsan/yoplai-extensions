import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "../index.js";
import { GoogleDriveClient } from "../client.js";
import type { ResolvedOAuth } from "../../tool-extension.js";

describe("googleDrive extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the expected extension contract with an oauth requirement", () => {
    expect(extension.id).toBe("googleDrive");
    expect(extension.displayName).toBe("Google Drive");
    expect(extension.requiredSecrets).toEqual([]);
    expect(extension.oauth).toEqual({
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
    expect(resolveOAuth).toHaveBeenCalledWith(agent, extension.oauth);
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
