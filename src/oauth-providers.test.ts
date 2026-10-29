import { describe, expect, it } from "vitest";
import { z } from "zod";

import gmail from "./gmail/index.js";
import googleCalendar from "./google-calendar/index.js";
import googleSearchConsole from "./google-search-console/index.js";
import googleAnalytics from "./google-analytics/index.js";
import googleDrive from "./google-drive/index.js";
import notion from "./notion/index.js";
import { defineToolExtension } from "./tool-extension.js";
import zendesk from "./zendesk/index.js";

describe("oauthProviders", () => {
  it("passes descriptors through defineToolExtension", () => {
    const provider = { id: "p", displayName: "P", authorizeUrl: "a", tokenUrl: "t", defaultScopes: [] };
    const extension = defineToolExtension({
      id: "x",
      displayName: "X",
      description: "X",
      configSchema: z.object({}),
      requiredSecrets: [],
      oauthProviders: [provider],
      createTools: () => [],
    });
    expect(extension.oauthProviders).toEqual([provider]);
  });

  it("shares one google descriptor across google extensions", () => {
    const [drive] = googleDrive.oauthProviders ?? [];
    expect(drive?.id).toBe("google");
    expect(gmail.oauthProviders?.[0]).toBe(drive);
    expect(googleCalendar.oauthProviders?.[0]).toBe(drive);
    expect(googleSearchConsole.oauthProviders?.[0]).toBe(drive);
    expect(googleAnalytics.oauthProviders?.[0]).toBe(drive);
    expect(drive?.extractAccount?.({ email: "a@b.c" })).toBe("a@b.c");
  });

  it("extracts the zendesk account email", () => {
    const [provider] = zendesk.oauthProviders ?? [];
    expect(provider?.extractAccount?.({ user: { email: "z@z.z" } })).toBe("z@z.z");
  });

  it("derives the notion account from the token response", () => {
    const [provider] = notion.oauthProviders ?? [];
    expect(provider?.accountFromTokenResponse?.({ owner: { user: { person: { email: "n@n.n" } } }, workspace_name: "W" })).toBe("n@n.n");
    expect(provider?.accountFromTokenResponse?.({ workspace_name: "W" })).toBe("W");
    expect(provider?.accountFromTokenResponse?.({})).toBeUndefined();
  });
});
