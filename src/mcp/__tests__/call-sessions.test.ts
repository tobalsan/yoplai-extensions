import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await dirs.cleanup(); });

function connection(token: string): OAuthConnection {
  return { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: token, token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" };
}

/** Fake OAuth MCP upstream: one record per connection (= one MCP session), with its token and traffic. */
function upstream() {
  type Session = { token: string | undefined; lists: number; calls: number; closed: boolean };
  const sessions: Session[] = [];
  const failures: Array<(session: Session) => unknown> = [];
  const factory = async (server: { name: string }, token?: string) => {
    const session: Session = { token, lists: 0, calls: 0, closed: false };
    sessions.push(session);
    return {
      async listTools() {
        session.lists++;
        return [{ server: server.name, name: "lookup", description: "Lookup", inputSchema: { type: "object" }, visibility: ["model", "app"] as ("model" | "app")[] }];
      },
      async readResource() { return { contents: [] }; },
      async callTool(_name: string, args: unknown) {
        session.calls++;
        const failure = failures.shift();
        if (failure) throw failure(session);
        return { content: [{ type: "text", text: `${token ?? "none"}:${JSON.stringify(args)}` }] };
      },
      async close() { session.closed = true; },
    };
  };
  return {
    factory,
    /** Sessions that served tool calls (the tool-list session only lists). */
    callSessions: () => sessions.filter((session) => session.calls > 0),
    sessions,
    failNextCall(error: (session: Session) => unknown) { failures.push(error); },
  };
}

async function setup() {
  const dir = await dirs.make("mcp-call-sessions-");
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp", oauth: { clientId: "client" } } } }));
  const host = credentials();
  const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: "https://remote.example.test/mcp", clientId: "client" }));
  await store.write("casey", "remote", connection("team-token"));
  await store.write("casey", "remote", connection("bob-token"), { type: "personal", userId: "bob" });
  await store.write("casey", "remote", connection("alice-token"), { type: "personal", userId: "alice" });
  const fake = upstream();
  const extension = createMcpExtension(fake.factory);
  const agent = { id: "casey", workspaceDir: dir };
  await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
  const [tool] = await extension.getAgentTools(agent, { userId: "bob", config: {} });
  const lookup = (args: Record<string, unknown>, userId?: string) => tool!.execute(args, userId ? { userId } : {});
  return { extension, store, fake, lookup };
}

const text = (token: string, args: Record<string, unknown>) => ({ content: [{ type: "text", text: `${token}:${JSON.stringify(args)}` }] });

describe("OAuth MCP call sessions", () => {
  it("serves a requester's repeated calls on one connection with one tool listing", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      for (let index = 0; index < 5; index++) {
        await expect(lookup({ company: index }, "bob")).resolves.toMatchObject(text("bob-token", { company: index }));
      }
      expect(fake.callSessions()).toHaveLength(1);
      expect(fake.callSessions()[0]).toMatchObject({ token: "bob-token", lists: 1, calls: 5, closed: false });
    } finally { await extension.stop(); }
  });

  it("shares one connection between concurrent calls of the same requester", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      await Promise.all(Array.from({ length: 10 }, (_, index) => lookup({ company: index }, "bob")));
      expect(fake.callSessions()).toHaveLength(1);
      expect(fake.callSessions()[0]!.calls).toBe(10);
    } finally { await extension.stop(); }
  });

  it("keeps each requester and the unattended team caller on their own connection", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("bob-token", {}));
      await expect(lookup({}, "alice")).resolves.toMatchObject(text("alice-token", {}));
      await expect(lookup({})).resolves.toMatchObject(text("team-token", {}));
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("bob-token", {}));
      expect(fake.callSessions().map((session) => [session.token, session.calls])).toEqual([["bob-token", 2], ["alice-token", 1], ["team-token", 1]]);
    } finally { await extension.stop(); }
  });

  it("moves to a new connection as soon as the stored credential changes", async () => {
    const { extension, store, fake, lookup } = await setup();
    try {
      await lookup({}, "bob");
      await store.write("casey", "remote", connection("bob-token-2"), { type: "personal", userId: "bob" });
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("bob-token-2", {}));
      await store.delete("casey", "remote", { type: "personal", userId: "bob" });
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("team-token", {}));
      expect(fake.callSessions().map((session) => session.token)).toEqual(["bob-token", "bob-token-2", "team-token"]);
    } finally { await extension.stop(); }
  });

  it("closes a call connection after five idle minutes and opens a new one for the next call", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await lookup({}, "bob");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await lookup({}, "bob");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(fake.callSessions()[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.callSessions()[0]!.closed).toBe(true);
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("bob-token", {}));
      expect(fake.callSessions().map((session) => session.calls)).toEqual([2, 1]);
    } finally { await extension.stop(); }
  });

  it("resends a call once on a new connection when the server no longer knows the session", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      await lookup({}, "bob");
      fake.failNextCall(() => Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: Unknown session"), { code: 404 }));
      await expect(lookup({ again: true }, "bob")).resolves.toMatchObject(text("bob-token", { again: true }));
      const [expired, renewed] = fake.callSessions();
      expect(expired).toMatchObject({ calls: 2, closed: true });
      expect(renewed).toMatchObject({ calls: 1, closed: false });
    } finally { await extension.stop(); }
  });

  it("does not resend a call refused with 404 on a session opened for it", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      fake.failNextCall(() => Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint: Not Found"), { code: 404 }));
      await expect(lookup({}, "bob")).rejects.toThrow("Not Found");
      expect(fake.callSessions()).toHaveLength(1);
    } finally { await extension.stop(); }
  });

  it("drops a connection whose call failed, without retrying, and reconnects for the next call", async () => {
    const { extension, fake, lookup } = await setup();
    try {
      await lookup({}, "bob");
      fake.failNextCall(() => new TypeError("fetch failed"));
      await expect(lookup({}, "bob")).rejects.toThrow("fetch failed");
      expect(fake.callSessions()).toHaveLength(1);
      expect(fake.callSessions()[0]!.closed).toBe(true);
      await expect(lookup({}, "bob")).resolves.toMatchObject(text("bob-token", {}));
      expect(fake.callSessions().map((session) => session.calls)).toEqual([2, 1]);
    } finally { await extension.stop(); }
  });

  it("closes call connections on stop", async () => {
    const { extension, fake, lookup } = await setup();
    await lookup({}, "bob");
    await lookup({}, "alice");
    await extension.stop();
    expect(fake.sessions.every((session) => session.closed)).toBe(true);
  });
});
