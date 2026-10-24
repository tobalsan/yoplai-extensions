import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await dirs.cleanup(); });

describe("MCP Apps OAuth cancellation isolation", () => {
  it("keeps protected-resource discovery within the call's one total deadline", async () => {
    const dir = await dirs.make("mcp-app-protected-resource-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
    let entered!: () => void;
    const discovering = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: Response) => void;
    const waitingMetadata = new Promise<Response>((resolve) => { release = resolve; });
    const urls: string[] = [];
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url) === "https://remote.example.test/mcp") return new Response("", { status: 200 });
      upstreamSignal = init?.signal;
      entered(); return waitingMetadata;
    });
    const factory = vi.fn(async () => { throw new Error("connection must not start after deadline"); });
    const extension = createMcpExtension(factory);
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    vi.useFakeTimers();
    const pending = extension.mcpApps.callTool({ agentId: "casey" }, "remote", "data", {});
    let settled = false;
    const outcome = pending.then((result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });
    try {
      await discovering;
      await vi.advanceTimersByTimeAsync(24_999);
      expect(upstreamSignal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ name: "McpAppsError", reason: "timeout" });
      release(new Response("", { status: 404 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(urls).toEqual(["https://remote.example.test/mcp", "https://remote.example.test/.well-known/oauth-protected-resource/mcp"]);
      expect(factory).not.toHaveBeenCalled();
    } finally { release(new Response("", { status: 404 })); await extension.stop(); }
  });

  it.each(["aborted", "completed"] as const)("shares one refresh while a concurrent viewer operation is %s", async (firstState) => {
    const dir = await dirs.make("mcp-app-refresh-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
    await store.write("casey", "remote", {
      client: { client_id: "client", redirect_uris: ["http://localhost/callback"] },
      tokens: { access_token: "team", token_type: "Bearer" }, connectedAt: "2026-01-01T00:00:00Z",
      authorizationServerUrl: "https://auth.example.test", state: "connected",
    });
    await store.write("casey", "remote", {
      client: { client_id: "client", redirect_uris: ["http://localhost/callback"] },
      tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer" },
      connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z",
      authorizationServerUrl: "https://auth.example.test", state: "connected",
    }, { type: "personal", userId: "viewer" });
    let entered!: () => void;
    const firstMetadata = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: Response) => void;
    const waitingMetadata = new Promise<Response>((resolve) => { release = resolve; });
    const metadataSignals: Array<AbortSignal | null | undefined> = [];
    const tokenRequests: string[] = [];
    const metadata = () => Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes(".well-known")) {
        metadataSignals.push(init?.signal);
        if (metadataSignals.length === 1) { entered(); return waitingMetadata; }
        return metadata();
      }
      tokenRequests.push(String(url));
      return Response.json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 });
    });
    const extension = createMcpExtension(async (_server, token) => ({
      async listTools() { return []; },
      async callTool() { return {}; },
      async readResource(uri) { return { contents: [{ uri, text: token }] }; },
      async close() {},
    }));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = extension.mcpApps.readResource({ agentId: "casey", userId: "viewer", signal: firstController.signal }, "remote", "ui://remote/view");
    const firstOutcome = first.catch((error: unknown) => error);
    await firstMetadata;
    const second = extension.mcpApps.readResource({ agentId: "casey", userId: "viewer", signal: secondController.signal }, "remote", "ui://remote/view");
    const secondOutcome = second.then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      // Both operations can finish their in-memory credential reads before the upstream replies.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (firstState === "aborted") firstController.abort();
      expect(metadataSignals).toHaveLength(1);
      expect(metadataSignals[0]?.aborted).toBe(false);
      release(metadata());
      if (firstState === "aborted") await expect(firstOutcome).resolves.toMatchObject({ name: "McpAppsError", reason: "aborted" });
      else await expect(firstOutcome).resolves.toEqual({ contents: [{ uri: "ui://remote/view", text: "fresh" }] });
      await expect(secondOutcome).resolves.toEqual({ result: { contents: [{ uri: "ui://remote/view", text: "fresh" }] } });
      expect(tokenRequests).toEqual(["https://auth.example.test/token"]);
    } finally {
      firstController.abort(); secondController.abort(); release(metadata());
      await Promise.allSettled([first, second]);
      await extension.stop();
    }
  });
});
