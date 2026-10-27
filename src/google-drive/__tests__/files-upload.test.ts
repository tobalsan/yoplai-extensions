import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function save(size = 5_000_001, signal?: AbortSignal) {
  const hostPath = await mkdtemp(path.join(tmpdir(), "drive-upload-"));
  roots.push(hostPath);
  const bytes = Buffer.alloc(size, 7);
  bytes.fill(3, 0, Math.min(size, 1_000_000));
  await writeFile(path.join(hostPath, "deck.pptx"), bytes);
  const tools = await extension.getAgentTools({ id: "agent", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test-token", scopes: [] }),
  });
  return tools.find(tool => tool.name === "googleDrive_save_file")!.execute({ path: "deck.pptx", name: "Deck", convert: true }, {
    agentId: "agent", sessionId: "session", userId: "user", signal,
    conversationFiles: { hostPath, runtimePath: "/workspace/files" },
  });
}

const networkFailure = () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) });
const uploaded = () => Response.json({ id: "deck", name: "Deck", mimeType: "application/vnd.google-apps.presentation" });
const sessionUrl = "https://www.googleapis.com/upload/drive/v3/files?upload_id=one";
const session = () => new Response(null, { headers: { location: sessionUrl } });

function interruptedUpload(statusResponse: () => Response | Promise<Response>, resume: (init: RequestInit) => Response | Promise<Response> = () => uploaded()) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (new URL(url).searchParams.get("uploadType") === "resumable") return session();
    expect(url).toBe(sessionUrl);
    const range = new Headers(init.headers).get("Content-Range");
    if (range === null) throw networkFailure();
    if (range === "bytes */5000001") return statusResponse();
    return resume(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("reports a small upload network failure as 502 with cause, size and stage without retrying its POST", async () => {
  const fetch = vi.fn(async () => { throw networkFailure(); });
  vi.stubGlobal("fetch", fetch);
  await expect(save(100)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/multipart.*100.*ECONNRESET.*socket closed/i) });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("resumes a large converted deck from the acknowledged byte without creating a second session", async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push(init);
    if (new URL(url).searchParams.get("uploadType") === "resumable") return session();
    expect(url).toBe(sessionUrl);
    const range = new Headers(init.headers).get("Content-Range");
    if (range === null) throw networkFailure();
    if (range === "bytes */5000001") {
      expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toHaveLength(0);
      return new Response(null, { status: 308, headers: { Range: "bytes=0-999999" } });
    }
    expect(range).toBe("bytes 1000000-5000000/5000001");
    expect(new Headers(init.headers).get("Content-Length")).toBe("4000001");
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    expect(body).toHaveLength(4_000_001);
    expect(body[0]).toBe(7);
    expect(body[4_000_000]).toBe(7);
    return uploaded();
  }));
  await expect(save()).resolves.toMatchObject({ fileId: "deck", mimeType: "application/vnd.google-apps.presentation" });
  expect(requests.filter(init => init.method === "POST")).toHaveLength(1);
  expect(requests.filter(init => init.method === "PUT")).toHaveLength(3);
});

it("resumes all bytes when Drive acknowledges none", async () => {
  interruptedUpload(() => new Response(null, { status: 308 }), async init => {
    expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-5000000/5000001");
    expect(new Headers(init.headers).get("Content-Length")).toBe("5000001");
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    expect(bytes).toHaveLength(5_000_001);
    expect(bytes[0]).toBe(3);
    expect(bytes[1_000_000]).toBe(7);
    return uploaded();
  });
  await expect(save()).resolves.toMatchObject({ fileId: "deck" });
});

it.each([200, 201])("returns a completed status query (%s) without sending more bytes", async status => {
  const fetch = interruptedUpload(() => new Response(JSON.stringify({ id: "complete", name: "Deck", mimeType: "application/vnd.google-apps.presentation" }), { status }), () => { throw new Error("Completed uploads must not resume"); });
  await expect(save()).resolves.toMatchObject({ fileId: "complete" });
  expect(fetch.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(2);
});

it.each(["network", 400, 503, 202] as const)("reports a failed status query (%s) as 502 without another upload", async failure => {
  const fetch = interruptedUpload(() => {
    if (failure === "network") throw networkFailure();
    return new Response("status query failed", { status: failure });
  }, () => { throw new Error("Failed status query must not resume"); });
  await expect(save()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/status query.*5000001/) });
  expect(fetch.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(2);
});

it("reports a failed resume with cause and size and never attempts a second recovery", async () => {
  const fetch = interruptedUpload(() => new Response(null, { status: 308, headers: { Range: "bytes=0-999999" } }), () => { throw networkFailure(); });
  await expect(save()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/resume PUT.*5000001.*ECONNRESET.*socket closed/i) });
  expect(fetch.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(3);
});

it("reports session start network failure without retrying a POST", async () => {
  const fetch = vi.fn(async () => { throw networkFailure(); });
  vi.stubGlobal("fetch", fetch);
  await expect(save()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/session start.*5000001.*ECONNRESET.*socket closed/i) });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not recover an aborted upload even when fetch throws a network TypeError", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (url: string) => {
    if (new URL(url).searchParams.get("uploadType") === "resumable") return session();
    controller.abort(new DOMException("cancelled", "AbortError"));
    throw networkFailure();
  });
  vi.stubGlobal("fetch", fetch);
  await expect(save(5_000_001, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["invalid", "bytes=0-5000001"])("rejects an invalid acknowledged range (%s) without sending corrupt resume bytes", async range => {
  const fetch = interruptedUpload(() => new Response(null, { status: 308, headers: { Range: range } }), () => { throw new Error("Invalid range must not resume"); });
  await expect(save()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/status query.*5000001.*range/i) });
  expect(fetch.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(2);
});
