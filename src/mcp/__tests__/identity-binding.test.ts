import { describe, expect, it } from "vitest";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";

const TEAM = { type: "team" as const };
const conn = (identity?: string): OAuthConnection => ({ client: { client_id: "c", redirect_uris: ["http://localhost/cb"] }, tokens: { access_token: "tok", token_type: "Bearer" }, connectedAt: "2024-01-01T00:00:00.000Z", authorizationServerUrl: "https://auth.test", state: "connected", ...(identity ? { identity } : {}) });

function setup(initial: OAuthConnection) {
  const host = credentials();
  let url = "https://a.test/mcp";
  const store = new McpOAuthStore("/nonexistent", "http://localhost/cb", host, () => ({ url }));
  host.save({ agentId: "a1", integration: "mcp:docs", scope: TEAM }, initial);
  return { host, store, setUrl: (value: string) => { url = value; } };
}

describe("OAuth grant identity binding", () => {
  it("rejects a team grant once the server key points at another URL", async () => {
    const t = setup(conn("https://a.test/mcp"));
    expect(await t.store.accessToken("a1", "docs")).toBe("tok");
    t.setUrl("https://b.test/mcp");
    expect(await t.store.read("a1", "docs")).toBeUndefined();
    expect(await t.store.resolve("a1", "docs")).toBeUndefined();
    expect(await t.store.accessToken("a1", "docs")).toBeUndefined();
    t.setUrl("https://a.test/mcp/");
    expect(await t.store.accessToken("a1", "docs")).toBe("tok");
  });

  it("accepts a legacy grant without identity and stamps it", async () => {
    const t = setup(conn());
    expect(await t.store.accessToken("a1", "docs")).toBe("tok");
    expect(t.host.get<OAuthConnection>({ agentId: "a1", integration: "mcp:docs", scope: TEAM })?.identity).toBe("https://a.test/mcp");
    t.setUrl("https://b.test/mcp");
    expect(await t.store.accessToken("a1", "docs")).toBeUndefined();
  });
});
