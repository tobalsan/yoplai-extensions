import { afterEach, describe, expect, it, vi } from "vitest";

import { extractAccountLabel, resolveAccountLabel, trustedUserinfoEndpoint, type AccountSession, type AccountTool } from "../account.js";

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = (tools: AccountTool[], result: unknown = { content: [{ type: "text", text: JSON.stringify({ email: "who@example.test" }) }] }) => {
  const callTool = vi.fn().mockResolvedValue(result);
  const close = vi.fn().mockResolvedValue(undefined);
  const value: AccountSession = { listTools: async () => ({ tools }), callTool, close };
  return { value, callTool, close, connect: vi.fn().mockResolvedValue(value) };
};
const base = { serverUrl: "https://mcp.example.test/mcp", authorizationServerUrl: "https://auth.example.test", tokens: { access_token: "opaque", token_type: "Bearer" } };

afterEach(() => { vi.unstubAllGlobals(); });

describe("resolveAccountLabel", () => {
  it("reads email then name from id_token without any network", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(resolveAccountLabel({ ...base, tokens: { ...base.tokens, id_token: jwt({ email: " a@example.test ", name: "A" }) } })).resolves.toBe("a@example.test");
    await expect(resolveAccountLabel({ ...base, tokens: { ...base.tokens, id_token: jwt({ name: "Ann" }) } })).resolves.toBe("Ann");
    await expect(resolveAccountLabel({ ...base, tokens: { ...base.tokens, access_token: jwt({ email: "jwt@example.test" }) } })).resolves.toBe("jwt@example.test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the OIDC userinfo endpoint with the bearer token", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/")) return json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/a", token_endpoint: "https://auth.example.test/t", response_types_supported: ["code"], userinfo_endpoint: "https://auth.example.test/userinfo" });
      return url === "https://auth.example.test/userinfo" ? json({ email: "oidc@example.test" }) : json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveAccountLabel(base)).resolves.toBe("oidc@example.test");
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example.test/userinfo", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer opaque" }) }));
  });

  it("never sends the token to a userinfo endpoint on another host or over plain HTTP", async () => {
    expect(trustedUserinfoEndpoint("https://auth.example.test/userinfo", "https://auth.example.test/tenant")).toBe("https://auth.example.test/userinfo");
    expect(trustedUserinfoEndpoint("https://evil.example.test/userinfo", "https://auth.example.test")).toBeUndefined();
    expect(trustedUserinfoEndpoint("http://auth.example.test/userinfo", "https://auth.example.test")).toBeUndefined();
    expect(trustedUserinfoEndpoint("http://169.254.169.254/latest", "https://auth.example.test")).toBeUndefined();
    const fetchMock = vi.fn(async (input: string | URL) => String(input).includes("/.well-known/")
      ? json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/a", token_endpoint: "https://auth.example.test/t", response_types_supported: ["code"], userinfo_endpoint: "http://10.0.0.1/userinfo" })
      : json({ email: "leak@example.test" }));
    vi.stubGlobal("fetch", fetchMock);
    const s = session([]);
    await expect(resolveAccountLabel({ ...base, connect: s.connect })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("http://10.0.0.1/userinfo");
  });

  it("aborts and closes the MCP session when the deadline passes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 404)));
    const close = vi.fn().mockResolvedValue(undefined);
    let seenSignal: AbortSignal | undefined;
    const hanging: AccountSession = { listTools: () => new Promise(() => undefined), callTool: vi.fn(), close };
    const connect = vi.fn(async (_url: string, _token: string, signal?: AbortSignal) => { seenSignal = signal; return hanging; });
    await expect(resolveAccountLabel({ ...base, connect, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(seenSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("uses the Pipedrive REST lookup", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => String(input) === "https://api.pipedrive.com/api/v1/users/me" ? json({ data: { email: "pd@example.test", name: "PD" } }) : json({}, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveAccountLabel({ ...base, serverUrl: "https://mcp.pipedrive.ai/mcp" })).resolves.toBe("pd@example.test");
  });

  it.each([["https://mcp.notion.com/mcp", "notion-get-users", { user_id: "self" }, { results: [{ type: "person", id: "1", name: "N", email: "n@example.test" }] }, "n@example.test"], ["https://mcp.linear.app/mcp", "get_user", { query: "me" }, { name: "Lin", email: "l@example.test" }, "l@example.test"]])("calls the built-in tool for %s", async (serverUrl, name, args, body, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 404)));
    const s = session([], { content: [{ type: "text", text: JSON.stringify(body) }] });
    await expect(resolveAccountLabel({ ...base, serverUrl, connect: s.connect })).resolves.toBe(expected);
    expect(s.callTool).toHaveBeenCalledWith({ name, arguments: args });
    expect(s.close).toHaveBeenCalled();
  });

  it("generic heuristic calls only a safe whoami tool and skips tools with required args", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 404)));
    const s = session([
      { name: "get_user", inputSchema: { required: ["id"] } },
      { name: "whoami", annotations: { readOnlyHint: false } },
      { name: "get-viewer", annotations: { destructiveHint: true } },
      { name: "Get_Current_User", inputSchema: { required: [] }, annotations: { readOnlyHint: true } },
    ]);
    await expect(resolveAccountLabel({ ...base, connect: s.connect })).resolves.toBe("who@example.test");
    expect(s.callTool).toHaveBeenCalledExactlyOnceWith({ name: "Get_Current_User", arguments: {} });
    const unsafe = session([{ name: "me", inputSchema: { required: ["x"] } }]);
    await expect(resolveAccountLabel({ ...base, connect: unsafe.connect })).resolves.toBeUndefined();
    expect(unsafe.callTool).not.toHaveBeenCalled();
  });

  it("returns undefined when every source fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    await expect(resolveAccountLabel({ ...base, connect: vi.fn().mockRejectedValue(new Error("no")) })).resolves.toBeUndefined();
    await expect(resolveAccountLabel({ ...base, tokens: { ...base.tokens, id_token: "garbage" }, connect: vi.fn().mockRejectedValue(new Error("no")) })).resolves.toBeUndefined();
  });
});

describe("extractAccountLabel", () => {
  it("prefers email, then text email, then name, and caps length", () => {
    expect(extractAccountLabel({ structuredContent: { user: { name: "N", email: "e@example.test" } } })).toBe("e@example.test");
    expect(extractAccountLabel({ content: [{ type: "text", text: "Logged in as bob@example.test today" }] })).toBe("bob@example.test");
    expect(extractAccountLabel({ content: [{ type: "text", text: JSON.stringify({ displayName: "Bob" }) }] })).toBe("Bob");
    expect(extractAccountLabel({ content: [{ type: "text", text: JSON.stringify({ name: "x".repeat(500) }) }] })).toHaveLength(200);
    expect(extractAccountLabel({ content: [{ type: "text", text: "nothing" }] })).toBeUndefined();
  });
});
