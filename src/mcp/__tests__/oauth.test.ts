import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { McpOAuthStore } from "../oauth.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("McpOAuthStore", () => {
  it("persists connections with owner-only permissions and survives a new store", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-"));
    dirs.push(dataDir);
    const connection = {
      client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] },
      tokens: { access_token: "token", token_type: "Bearer" },
      connectedAt: "2026-07-22T00:00:00.000Z",
      authorizationServerUrl: "https://auth.example.test",
      state: "connected" as const,
    };
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback");
    await store.write("casey", "claap", connection);

    await expect(new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback").read("casey", "claap")).resolves.toEqual(connection);
    const root = path.join(dataDir, "mcp", "oauth");
    const agentDir = path.join(root, (await fs.readdir(root))[0]!);
    const tokenFile = path.join(agentDir, (await fs.readdir(agentDir))[0]!);
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("marks a stored connection as needing reconnect", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-"));
    dirs.push(dataDir);
    const store = new McpOAuthStore(dataDir, "http://localhost:4000/api/mcp/oauth/callback");
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: ["http://localhost:4000/api/mcp/oauth/callback"] }, tokens: { access_token: "token", token_type: "Bearer" }, connectedAt: "2026-07-22T00:00:00.000Z", authorizationServerUrl: "https://auth.example.test" });
    await store.markNeedsReconnect("casey", "claap");
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ state: "needs_reconnect" });
  });
});
