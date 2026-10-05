import { credentials } from "./credentials.js";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { McpOAuthStore } from "../oauth.js";

let hostCredentials = credentials();
const dirs: string[] = [];
afterEach(async () => { hostCredentials = credentials(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("McpOAuthStore", () => {
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
