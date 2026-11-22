import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { McpOAuthStore, type CredentialKey, type OAuthConnection } from "../oauth.js";
import { credentials } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const grant: OAuthConnection = {
  client: { client_id: "client", redirect_uris: [] },
  tokens: { access_token: "access-old", refresh_token: "refresh-old", token_type: "Bearer" },
  connectedAt: "2026-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z",
  authorizationServerUrl: "https://auth.example.test", state: "connected",
};
const rotated = { access_token: "access-new", refresh_token: "refresh-new", token_type: "Bearer", expires_in: 899 };
async function setup(connection = grant, host = credentials()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-refresh-")); dirs.push(dir);
  const store = new McpOAuthStore(dir, "http://localhost/callback", host);
  await store.write("agent", "example", connection);
  return store;
}
function endpoint(token: (init?: RequestInit) => Promise<Response>) {
  const bodies: URLSearchParams[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes(".well-known")) return Response.json({ issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"] });
    bodies.push(new URLSearchParams(String(init?.body)));
    return token(init);
  }));
  return bodies;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it("shares one token request between two status checks and a tool load", async () => {
  const store = await setup();
  let finish!: (response: Response) => void;
  const bodies = endpoint(() => new Promise((resolve) => { finish = resolve; }));
  const pending = [
    store.accessTokenResult("agent", "example", 60_000, undefined, undefined, "status", true),
    store.accessTokenResult("agent", "example", 60_000, undefined, undefined, "status", true),
    store.accessTokenResult("agent", "example"),
  ];
  await turn();
  expect(bodies).toHaveLength(1);
  finish(Response.json(rotated));
  expect(await Promise.all(pending)).toEqual(Array(3).fill({ token: "access-new", scope: "team" }));
});

it.each(["status abort", "tool timeout", "last waiter abort"])("saves issued tokens after %s and uses the rotated refresh token next", async (departure) => {
  const store = await setup();
  const controller = new AbortController();
  let finish!: () => void;
  const bodies = endpoint(async () => bodies.length === 1 ? new Response(new ReadableStream({
    start(stream) { finish = () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(rotated))); stream.close(); }; },
  }), { headers: { "content-type": "application/json" } }) : Response.json({ ...rotated, access_token: "access-next" }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const status = departure === "status abort";
  const pending = store.accessTokenResult("agent", "example", 60_000, undefined, undefined, status ? "status" : "tools", status, departure === "tool timeout" ? undefined : controller.signal);
  await turn();
  expect(bodies).toHaveLength(1);
  if (departure !== "tool timeout") controller.abort(new Error("status deadline"));
  else await vi.advanceTimersByTimeAsync(10_001);
  await expect(pending).resolves.toMatchObject({ reason: "refresh_failed", scope: "team", ...(status ? { error: { category: "timeout" } } : {}) });
  if (!status) expect(await pending).not.toHaveProperty("error");
  finish();
  await vi.waitFor(async () => expect(await store.read("agent", "example")).toMatchObject({ tokens: rotated, state: "connected" }));
  await expect(store.refreshAccessTokenResult("agent", "example")).resolves.toMatchObject({ token: "access-next" });
  expect(bodies.map((body) => body.get("refresh_token"))).toEqual(["refresh-old", "refresh-new"]);
});

it.each(["expired", "fresh", "gone", "needs_reconnect"])("rechecks the stored grant when an earlier read became stale: %s", async (state) => {
  const host = credentials();
  const store = await setup(grant, host);
  const originalGet = host.get.bind(host);
  let replace = true;
  host.get = <T>(key: CredentialKey) => {
    const old = originalGet<T>(key);
    if (replace) {
      replace = false;
      if (state === "gone") host.delete(key);
      else host.save(key, { ...grant, tokens: { ...grant.tokens, access_token: "access-latest", refresh_token: "refresh-latest" }, ...(state === "fresh" ? { expiresAt: "2099-01-01T00:00:00Z" } : {}), ...(state === "needs_reconnect" ? { state } : {}) });
    }
    return old;
  };
  const bodies = endpoint(async () => Response.json(rotated));
  const result = await store.accessTokenResult("agent", "example", 60_000, undefined, { type: "team" });
  if (state === "expired") {
    expect(result).toEqual({ token: "access-new", scope: "team" });
    expect(bodies.map((body) => body.get("refresh_token"))).toEqual(["refresh-latest"]);
  } else {
    expect(result).toMatchObject(state === "fresh" ? { token: "access-latest", scope: "team" } : { reason: state === "gone" ? "not_connected" : state });
    expect(bodies).toHaveLength(0);
  }
});

it("returns the replacement token after a stale token's 401 without refreshing again", async () => {
  const store = await setup();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const bodies = endpoint(async () => Response.json(rotated));
  await expect(store.accessTokenResult("agent", "example")).resolves.toEqual({ token: "access-new", scope: "team" });
  await expect(store.refreshAccessTokenResult("agent", "example", undefined, undefined, "call", false, undefined, "access-old")).resolves.toEqual({ token: "access-new", scope: "team" });
  expect(bodies).toHaveLength(1);
  await store.accessTokenResult("agent", "example");
  expect(output).toHaveBeenCalledOnce();
});

it.each([true, false])("shares failure handling from the initiating status=%s caller and projects errors per caller", async (statusOnly) => {
  const store = await setup();
  let fail!: (error: Error) => void;
  const bodies = endpoint(() => new Promise((_resolve, reject) => { fail = reject; }));
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = store.accessTokenResult("agent", "example", 60_000, undefined, undefined, statusOnly ? "status" : "tools", statusOnly);
  await turn();
  const second = store.accessTokenResult("agent", "example", 60_000, undefined, undefined, statusOnly ? "tools" : "status", !statusOnly);
  await turn();
  fail(new TypeError("fetch failed"));
  const results = await Promise.all([first, second]);
  expect(results[statusOnly ? 0 : 1]).toEqual({ reason: "refresh_failed", scope: "team", error: { category: "network", message: "fetch failed" } });
  expect(results[statusOnly ? 1 : 0]).toEqual({ reason: "refresh_failed", scope: "team" });
  expect((await store.read("agent", "example"))?.state).toBe("connected");
  expect(bodies).toHaveLength(1);
  expect(output).toHaveBeenCalledOnce();
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ level: "warn", reason: "refresh_failed" });
});

it("keeps a hung tools refresh shared after callers leave, then aborts it at 30 seconds and permits another attempt", async () => {
  const store = await setup();
  let upstreamSignal: AbortSignal | null | undefined;
  const bodies = endpoint(async (init) => {
    if (bodies.length > 1) return Response.json(rotated);
    upstreamSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), { once: true }));
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = store.accessTokenResult("agent", "example");
  await turn();
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(first).resolves.toMatchObject({ reason: "refresh_failed" });
  expect(upstreamSignal?.aborted).toBe(false);
  const second = store.accessTokenResult("agent", "example");
  await turn();
  expect(bodies).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(second).resolves.toEqual({ reason: "refresh_failed", scope: "team" });
  await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
  expect(upstreamSignal?.aborted).toBe(true);
  expect((await store.read("agent", "example"))?.state).toBe("connected");
  await expect(store.accessTokenResult("agent", "example")).resolves.toEqual({ token: "access-new", scope: "team" });
  expect(bodies).toHaveLength(2);
});

it.each([true, false].flatMap((statusOnly) => ["parsed", "message"].flatMap((form) => [5, 15, undefined].map((age) => ({ statusOnly, form, age })))))("handles $form invalid_grant at age $age min (status=$statusOnly)", async ({ statusOnly, form, age }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T12:00:00Z"));
  const issuedAt = age === undefined ? undefined : new Date(Date.now() - age * 60_000).toISOString();
  const store = await setup({ ...grant, issuedAt });
  endpoint(async () => {
    if (form === "message") throw new Error('HTTP 400: {"error":"invalid_grant","error_description":"Refused"}');
    return Response.json({ error: "invalid_grant", error_description: "Refused" }, { status: 400 });
  });
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await store.refreshAccessTokenResult("agent", "example", undefined, undefined, statusOnly ? "status" : "tools", statusOnly);
  expect(result).toMatchObject({ reason: "refresh_failed", scope: "team" });
  if (statusOnly) expect(result.error).toMatchObject({ category: "authentication", message: form === "parsed" ? "Refused" : expect.stringContaining("invalid_grant") });
  else expect(result).not.toHaveProperty("error");
  expect(await store.read("agent", "example")).toMatchObject({ state: age === 5 ? "connected" : "needs_reconnect", tokens: grant.tokens });
  expect(output).toHaveBeenCalledOnce();
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ level: "error", reason: "refresh_failed" });
});

it.each([true, false])("requires reconnect when the token endpoint returns HTTP 401 with an OAuth error (status=%s)", async (statusOnly) => {
  const store = await setup();
  endpoint(async () => Response.json({ error: "access_denied", error_description: "Refused" }, { status: 401 }));
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await store.refreshAccessTokenResult("agent", "example", undefined, undefined, statusOnly ? "status" : "tools", statusOnly);
  expect(result).toEqual({ reason: "refresh_failed", scope: "team", ...(statusOnly ? { error: { category: "authentication", message: "Refused" } } : {}) });
  expect(await store.read("agent", "example")).toMatchObject({ state: "needs_reconnect" });
  expect(output).toHaveBeenCalledOnce();
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ level: "error", reason: "refresh_failed" });
});

it("records the issue time of rotated tokens without changing the connection time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T12:00:00Z"));
  const store = await setup();
  endpoint(async () => Response.json(rotated));
  await store.accessTokenResult("agent", "example");
  expect(await store.read("agent", "example")).toMatchObject({ issuedAt: "2026-02-01T12:00:00.000Z", connectedAt: "2026-01-01T00:00:00Z" });
});

it.each(["saved", "dropped", "refused"])("logs one structured refresh with fingerprints and no token values: %s", async (outcome) => {
  const store = await setup();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  endpoint(async () => {
    if (outcome === "dropped") await store.delete("agent", "example");
    return outcome === "refused" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json(rotated);
  });
  await store.accessTokenResult("agent", "example");
  expect(output).toHaveBeenCalledOnce();
  const line = output.mock.calls[0]![0];
  expect(JSON.parse(line)).toMatchObject({ level: "info", agentId: "agent", server: "example", scope: "team", path: "tools", statusOnly: false, result: { status: outcome === "refused" ? 400 : 200 }, saved: outcome === "saved", dropped: outcome === "dropped", oldRefreshFp: "de1d36e8", ...(outcome === "refused" ? { result: { status: 400, error: "invalid_grant" } } : { newRefreshFp: "5064cad0", expires_in: 899 }) });
  for (const secret of ["access-old", "access-new", "refresh-old", "refresh-new"]) expect(line).not.toContain(secret);
  if (outcome === "refused") expect(JSON.parse(line)).not.toHaveProperty("newRefreshFp");
});
