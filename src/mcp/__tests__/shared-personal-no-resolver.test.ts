import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentials } from "./credentials.js";

afterEach(() => { vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js"); vi.resetModules(); vi.unstubAllGlobals(); });

describe("McpOAuthStore without an identity resolver", () => {
  it("personal begin -> finish -> accessToken -> disconnect round-trips on one key", async () => {
    vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => ({
      discoverOAuthServerInfo: vi.fn().mockResolvedValue({ authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: { authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", registration_endpoint: "https://auth.example.test/register" } }),
      registerClient: vi.fn().mockResolvedValue({ client_id: "dyn", redirect_uris: [] }),
      startAuthorization: vi.fn().mockImplementation((_url, options) => ({ authorizationUrl: new URL(`https://auth.example.test/authorize?state=${options.state}`), codeVerifier: "verifier" })),
      exchangeAuthorization: vi.fn().mockResolvedValue({ access_token: "tok", token_type: "Bearer" }),
      refreshAuthorization: vi.fn(), discoverAuthorizationServerMetadata: vi.fn().mockResolvedValue(undefined),
    }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { McpOAuthStore } = await import("../oauth.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-noresolver-"));
    try {
      const store = new McpOAuthStore(dir, "http://localhost/callback", credentials());
      const scope = { type: "personal" as const, userId: "A" };
      const { state } = await store.begin("sally", "claap", "https://claap.example.test/mcp", undefined, scope);
      await store.finish(state, "code");
      await expect(store.accessToken("sally", "claap", 60_000, "A")).resolves.toBe("tok");
      await expect(store.disconnect("sally", "claap", scope)).resolves.toBe(true);
      await expect(store.accessToken("sally", "claap", 60_000, "A")).resolves.toBeUndefined();
      await expect(store.read("sally", "claap", scope)).resolves.toBeUndefined();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
