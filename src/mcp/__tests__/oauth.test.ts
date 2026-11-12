import { credentials } from "./credentials.js";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpOAuthStore } from "../oauth.js";

let hostCredentials = credentials();
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); hostCredentials = credentials(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("McpOAuthStore", () => {
  it.each(["failure", "timeout"])("logs one contextual error for a shared refresh %s", async (outcome) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-refresh-log-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost/callback", hostCredentials);
    await store.write("casey", "remote", {
      client: { client_id: "client", redirect_uris: [] },
      tokens: { access_token: "expired-secret", refresh_token: "refresh-secret", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.example.test",
    });
    let started!: () => void;
    let fail!: (error: Error) => void;
    const refreshing = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
      started();
      return new Promise<Response>((_resolve, reject) => { fail = reject; });
    });
    vi.stubGlobal("fetch", fetcher);
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const pending = Array.from({ length: 4 }, () => store.accessToken("casey", "remote", 60_000, "alice", undefined, "call"));
    await refreshing;
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(10_001);
    else fail(new Error("Refresh failed https://auth.example.test/token?token=abc\ntry again"));
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined, undefined]);
    expect(output.mock.calls).toHaveLength(1);
    const line = output.mock.calls[0]![0];
    expect(line.startsWith('{"level"')).toBe(true);
    expect(line).not.toMatch(/[\r\n]|token=abc|expired-secret|refresh-secret/);
    expect(JSON.parse(line)).toEqual({
      level: "error", msg: outcome === "timeout"
        ? '[mcp] server "remote" unavailable: OAuth refresh timed out'
        : '[mcp] server "remote" unavailable: Refresh failed https://auth.example.test/token try again',
      server: "remote", agentId: "casey", userId: "alice", path: "call", reason: "refresh_failed", scope: "team",
    });
    await expect(store.accessToken("casey", "remote")).resolves.toBeUndefined();
    expect(output.mock.calls).toHaveLength(1);
    const flagged = await store.read("casey", "remote");
    await store.write("casey", "remote", { ...flagged!, state: "connected" });
    fetcher.mockImplementation(async () => { throw new Error("another attempt failed"); });
    await expect(store.refreshAccessToken("casey", "remote", "alice", undefined, "status")).resolves.toBeUndefined();
    expect(output.mock.calls).toHaveLength(2);
    expect(JSON.parse(output.mock.calls[1]![0])).toMatchObject({ level: "error", reason: "refresh_failed", path: "status" });
  });

  it("refreshes an expired grant for the MCP server it was issued for (RFC 8707 resource) and stores the new tokens", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-refresh-resource-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost/callback", hostCredentials, () => ({ url: "https://mcp.remote.example/mcp" }));
    await store.write("henry", "remote", {
      client: { client_id: "https://yoplai.example/oauth/client-metadata.json", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none" }, clientSource: "cimd",
      tokens: { access_token: "expired", refresh_token: "refresh-1", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.remote.example", state: "connected",
    });
    const tokenBodies: URLSearchParams[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.remote.example", authorization_endpoint: "https://auth.remote.example/authorize", token_endpoint: "https://auth.remote.example/token", response_types_supported: ["code"] });
      tokenBodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
    }));
    await expect(store.accessToken("henry", "remote", 60_000, "phuong")).resolves.toBe("fresh");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]!.get("grant_type")).toBe("refresh_token");
    expect(tokenBodies[0]!.get("refresh_token")).toBe("refresh-1");
    expect(tokenBodies[0]!.get("resource")).toBe("https://mcp.remote.example/mcp");
    expect(await store.read("henry", "remote")).toMatchObject({ state: "connected", tokens: { access_token: "fresh", refresh_token: "refresh-2" } });
  });

  it("logs the token endpoint's status and body when a refresh is refused, even after the global Response class was swapped", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-refresh-refused-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost/callback", hostCredentials, () => ({ url: "https://mcp.remote.example/mcp" }));
    await store.write("henry", "remote", {
      client: { client_id: "client", redirect_uris: [] },
      tokens: { access_token: "expired", refresh_token: "refresh-1", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z", authorizationServerUrl: "https://auth.remote.example", state: "connected",
    });
    // Prod: undici.install() replaces globalThis.Response after fetch was captured, so fetch results fail `instanceof Response`.
    const FetchResponse = Response;
    vi.stubGlobal("Response", class InstalledResponse extends FetchResponse {});
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes(".well-known")
      ? FetchResponse.json({ issuer: "https://auth.remote.example", authorization_endpoint: "https://auth.remote.example/authorize", token_endpoint: "https://auth.remote.example/token", response_types_supported: ["code"] })
      : new FetchResponse('{"error":"invalid_grant","error_description":"Refresh token expired"}', { status: 400, headers: { "content-type": "application/json" } })));
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(store.accessToken("henry", "remote", 60_000, "phuong")).resolves.toBeUndefined();
    expect(output.mock.calls).toHaveLength(1);
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual({
      level: "error", msg: '[mcp] server "remote" unavailable: HTTP 400: {"error":"invalid_grant","error_description":"Refresh token expired"}',
      server: "remote", agentId: "henry", userId: "phuong", path: "tools", reason: "refresh_failed", scope: "team",
    });
    expect((await store.read("henry", "remote"))?.state).toBe("needs_reconnect");
  });

  it("persists connections in the shared host store and survives a new wrapper", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-"));
    dirs.push(dataDir);
    const connection = {
      client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] },
      tokens: { access_token: "token", token_type: "Bearer" },
      connectedAt: "2026-07-22T00:00:00.000Z",
      authorizationServerUrl: "https://auth.example.test",
      state: "connected" as const,
    };
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials);
    await store.write("casey", "claap", connection);

    await expect(new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials).read("casey", "claap")).resolves.toEqual(connection);
    await expect(fs.stat(path.join(dataDir, "mcp", "oauth"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a stored connection as needing reconnect", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback", hostCredentials);
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }, tokens: { access_token: "token", token_type: "Bearer" }, connectedAt: "2026-07-22T00:00:00.000Z", authorizationServerUrl: "https://auth.example.test" });
    await store.markNeedsReconnect("casey", "claap");
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ state: "needs_reconnect" });
  });

  it("resolves personal first, team for other users, and preserves an unusable personal grant", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-scoped-")); dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://gateway.test/callback", hostCredentials);
    const connection = { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "team", token_type: "Bearer" }, connectedAt: "now", authorizationServerUrl: "https://auth.test" };
    await store.write("agent", "claap", connection);
    await store.write("agent", "claap", { ...connection, tokens: { ...connection.tokens, access_token: "a" } }, { type: "personal", userId: "a" });
    await expect(store.accessToken("agent", "claap", 60_000, "a")).resolves.toBe("a");
    await expect(store.accessToken("agent", "claap", 60_000, "b")).resolves.toBe("team");
    await expect(store.accessToken("agent", "claap")).resolves.toBe("team");
    await store.markNeedsReconnect("agent", "claap", { type: "personal", userId: "a" });
    await expect(store.accessToken("agent", "claap", 60_000, "a")).resolves.toBeUndefined();
    await expect(store.accessToken("agent", "claap", 60_000, "b")).resolves.toBe("team");
    await store.delete("agent", "claap");
    await expect(store.accessToken("agent", "claap", 60_000, "b")).resolves.toBeUndefined();
  });

  it("migrates legacy connections to team only after host persistence succeeds", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-migrate-")); dirs.push(dataDir);
    const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
    const file = path.join(dataDir, "mcp", "oauth", hash("agent"), `${hash("claap")}.json`);
    const legacy = { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "legacy", token_type: "Bearer" }, connectedAt: "now", authorizationServerUrl: "https://auth.test" };
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(legacy));
    const unavailable = { ...hostCredentials, save<T>(): T { throw new Error("Encryption unavailable"); } };
    await expect(new McpOAuthStore(dataDir, "http://gateway/callback", unavailable).accessToken("agent", "claap", 60_000, "b")).resolves.toBe("legacy");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(legacy);
    const store = new McpOAuthStore(dataDir, "http://gateway/callback", hostCredentials);
    await expect(store.accessToken("agent", "claap", 60_000, "a")).resolves.toBe("legacy");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(hostCredentials.get({ agentId: "agent", integration: "mcp:claap", scope: { type: "team" } })).toEqual(legacy);
    await expect(new McpOAuthStore(dataDir, "http://gateway/callback").write("agent", "claap", legacy)).rejects.toThrow("host scoped credential store");
  });
});
