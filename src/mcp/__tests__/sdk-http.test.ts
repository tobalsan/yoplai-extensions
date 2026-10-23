import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { SdkMcpClientHandle } from "../client-manager.js";

const server = { type: "http" as const, name: "remote", url: "https://mcp.example.test/mcp" };

function httpServer() {
  const requests: Array<{ method: string; authorization: string | null; session: string | null; rpc?: string; signal?: AbortSignal | null }> = [];
  let callStatus = 200;
  let end: () => Promise<Response> = async () => new Response(null, { status: 204 });
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const rpc = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", authorization: headers.get("authorization"), session: headers.get("mcp-session-id"), rpc: rpc?.method, signal: init?.signal });
    if (init?.method === "DELETE") return end();
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    if (!rpc?.id && rpc?.id !== 0) return new Response(null, { status: 202 });
    if (rpc.method === "tools/call" && callStatus !== 200) return new Response("Unknown session", { status: callStatus });
    const result = rpc.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { content: [{ type: "text", text: "ok" }] };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: rpc.method === "initialize" ? { "mcp-session-id": "session-one" } : {} });
  });
  return { requests, setCallStatus(status: number) { callStatus = status; }, setEnd(handler: typeof end) { end = handler; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SDK HTTP session", () => {
  it("reads the current token for every request while keeping the MCP session", async () => {
    const remote = httpServer();
    let token = "first-token";
    const client = await SdkMcpClientHandle.connect(server, token, false, async () => token);
    try {
      await client.callTool("tenant", {});
      token = "refreshed-token";
      await client.callTool("tenant", {});
      expect(remote.requests.filter((request) => request.rpc === "tools/call").map(({ authorization, session }) => ({ authorization, session }))).toEqual([
        { authorization: "Bearer first-token", session: "session-one" },
        { authorization: "Bearer refreshed-token", session: "session-one" },
      ]);
      expect(remote.requests.filter((request) => request.rpc === "initialize")).toHaveLength(1);
    } finally { await client.close(); }
  });

  it("ends the server session before closing its transport", async () => {
    const remote = httpServer();
    let abortedAtDelete: boolean | undefined;
    remote.setEnd(async () => {
      abortedAtDelete = remote.requests.at(-1)?.signal?.aborted;
      return new Response(null, { status: 204 });
    });
    const client = await SdkMcpClientHandle.connect(server, "token", false, async () => "token");
    await client.close();
    const deletion = remote.requests.find((request) => request.method === "DELETE");
    expect(deletion).toMatchObject({ authorization: "Bearer token", session: "session-one" });
    expect(abortedAtDelete).toBe(false);
    expect(deletion?.signal?.aborted).toBe(true);
  });

  it("closes the transport even when the server rejects session termination", async () => {
    const remote = httpServer();
    remote.setEnd(async () => new Response("Unavailable", { status: 503 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await SdkMcpClientHandle.connect(server, "token", false, async () => "token");
    await expect(client.close()).resolves.toBeUndefined();
    expect(remote.requests.find((request) => request.method === "DELETE")?.signal?.aborted).toBe(true);
    expect(log).toHaveBeenCalled();
  });

  it("bounds a hanging session end request at five seconds and aborts the transport", async () => {
    const remote = httpServer();
    remote.setEnd(() => new Promise(() => {}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await SdkMcpClientHandle.connect(server, "token", false, async () => "token");
    vi.useFakeTimers();
    let closed = false;
    const closing = client.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);
    expect(remote.requests.find((request) => request.method === "DELETE")?.signal?.aborted).toBe(true);
    await closing;
  });

  it("exposes an expired-session POST as a typed HTTP 404", async () => {
    const remote = httpServer();
    const client = await SdkMcpClientHandle.connect(server, "token", false, async () => "token");
    remote.setCallStatus(404);
    try {
      const error = await client.callTool("tenant", {}).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StreamableHTTPError);
      expect(error).toMatchObject({ code: 404 });
    } finally { await client.close(); }
  });

  it("keeps static-header servers independent of OAuth tokens and session termination", async () => {
    const remote = httpServer();
    const token = vi.fn(async () => "oauth-token");
    const client = await SdkMcpClientHandle.connect({ ...server, headers: { Authorization: "Bearer configured-token" } }, "initial-token", false, token);
    await client.callTool("tenant", {});
    await client.close();
    expect(remote.requests.every((request) => request.authorization === "Bearer configured-token")).toBe(true);
    expect(remote.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(token).not.toHaveBeenCalled();
  });

  it("reads current OAuth tokens for legacy SSE requests too", async () => {
    const authorizations: Array<string | null> = [];
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const events = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const send = (value: unknown) => stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`));
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (init?.method !== "POST") {
        stream.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
        return new Response(events, { headers: { "content-type": "text/event-stream" } });
      }
      const rpc = JSON.parse(String(init.body));
      if (rpc.id !== undefined) send({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { content: [{ type: "text", text: "ok" }] } });
      return new Response(null, { status: 202 });
    });
    let token = "first-token";
    const client = await SdkMcpClientHandle.connect({ ...server, url: "https://mcp.example.test/sse" }, token, false, async () => token);
    try {
      await client.callTool("tenant", {});
      token = "new-token";
      await client.callTool("tenant", {});
      expect(authorizations[0]).toBe("Bearer first-token");
      expect(authorizations.slice(-2)).toEqual(["Bearer first-token", "Bearer new-token"]);
    } finally { await client.close(); stream!.close(); }
  });
});

it("ends a disconnected session with its last valid token rather than another account", async () => {
  const remote = httpServer();
  let token: string | undefined = "original-account";
  const client = await SdkMcpClientHandle.connect(server, token, false, async () => token);
  await client.callTool("tenant", {});
  token = undefined;
  await client.close();
  expect(remote.requests.find((request) => request.method === "DELETE")).toMatchObject({ authorization: "Bearer original-account", session: "session-one" });
});

it("uses a refreshed pinned credential when ending an idle session", async () => {
  const remote = httpServer();
  let token = "expired-token";
  const client = await SdkMcpClientHandle.connect(server, token, false, async () => token);
  token = "current-token";
  await client.close();
  expect(remote.requests.find((request) => request.method === "DELETE")).toMatchObject({ authorization: "Bearer current-token", session: "session-one" });
});

it("ends an initialized server session when the remaining connect handshake fails", async () => {
  const remote = httpServer();
  const original = fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const rpc = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (rpc?.method === "notifications/initialized") return new Response("unavailable", { status: 503 });
    return original(input, init);
  });
  await expect(SdkMcpClientHandle.connect(server, "token", false, async () => "token")).rejects.toMatchObject({ code: 503 });
  expect(remote.requests.find((request) => request.method === "DELETE")).toMatchObject({ authorization: "Bearer token", session: "session-one" });
});
