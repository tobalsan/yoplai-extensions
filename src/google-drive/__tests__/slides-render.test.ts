import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const hostPath = await mkdtemp(path.join(tmpdir(), "slides-render-"));
  roots.push(hostPath);
  const tools = await extension.getAgentTools({ id: "agent", extensions: { googleDrive: {} } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test-token", scopes: [] }),
  });
  const context = { conversationFiles: { hostPath, runtimePath: "/workspace/files" } };
  return { hostPath, context, execute: (params: unknown, signal?: AbortSignal) => {
    const tool = tools.find((tool) => tool.name === "googleDrive_slides_render");
    if (!tool) throw new Error("slides_render unavailable");
    return tool.execute(params, { ...context, signal });
  } };
}
const deck = () => Response.json({ slides: [{ objectId: "first" }, { objectId: "second" }, { objectId: "third" }] });
const thumbnail = (id: string) => Response.json({ contentUrl: `https://images.example/${id}?signed=private`, width: 1600, height: 900 });

it("renders selected slides in presentation order using unauthenticated PNG downloads and runtime paths", async () => {
  const run = await setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "images.example") {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(`PNG ${url.pathname}`);
    }
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    if (!url.pathname.endsWith("/thumbnail")) return deck();
    expect(url.searchParams.get("thumbnailProperties.mimeType")).toBe("PNG");
    expect(url.searchParams.get("thumbnailProperties.thumbnailSize")).toBe("LARGE");
    return thumbnail(url.pathname.includes("/first/") ? "first" : "third");
  }));
  const result = await run.execute({ presentationId: "deck", slideIds: ["third", "first"] }) as { presentationId: string; slides: Array<{ slideId: string; slideNumber: number; path: string }> };
  expect(result).toMatchObject({ presentationId: "deck", slides: [
    { slideId: "first", slideNumber: 1, width: 1600, height: 900 },
    { slideId: "third", slideNumber: 3, width: 1600, height: 900 },
  ] });
  for (const slide of result.slides) {
    expect(slide.path.startsWith("/workspace/files/")).toBe(true);
    expect(await readFile(path.join(run.hostPath, path.basename(slide.path)), "utf8")).toBe(`PNG /${slide.slideId}`);
  }
  expect(JSON.stringify(result)).not.toMatch(/images\.example|signed=private|test-token/);
});

it("stops an image over 10 MB, removes this call's renders, and preserves earlier renders", async () => {
  const run = await setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") return new Response("previous PNG");
    return url.pathname.endsWith("/thumbnail") ? thumbnail("first") : deck();
  }));
  const earlier = await run.execute({ presentationId: "deck", slideIds: ["first"] }) as { slides: Array<{ path: string }> };
  let sent = 0;
  let cancelled = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") {
      if (url.pathname === "/first") return new Response("new PNG");
      return new Response(new ReadableStream({ pull(stream) {
        stream.enqueue(new Uint8Array(1_000_000));
        sent += 1_000_000;
        if (sent >= 12_000_000) stream.close();
      }, cancel() { cancelled = true; } }));
    }
    if (!url.pathname.endsWith("/thumbnail")) return deck();
    return thumbnail(url.pathname.includes("/first/") ? "first" : "second");
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first", "second"] })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/10 MB/) });
  expect(sent).toBeLessThanOrEqual(12_000_000);
  expect(cancelled).toBe(true);
  expect(await readdir(run.hostPath)).toEqual([path.basename(earlier.slides[0].path)]);
  expect(await readFile(path.join(run.hostPath, path.basename(earlier.slides[0].path)), "utf8")).toBe("previous PNG");
});

it("cancels a stalled image stream, removes completed and partial renders, and permits other conversation work", async () => {
  const run = await setup();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let pulls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") {
      if (url.pathname === "/first") return new Response("complete PNG");
      return new Response(new ReadableStream({ pull(stream) {
        if (pulls++ === 0) stream.enqueue(new Uint8Array([1, 2, 3]));
        else { started(); return new Promise(() => {}); }
      } }));
    }
    return url.pathname.endsWith("/thumbnail") ? thumbnail(url.pathname.includes("/first/") ? "first" : "second") : deck();
  }));
  const pending = run.execute({ presentationId: "deck", slideIds: ["first", "second"] }, controller.signal);
  await ready;
  const rejection = expect(pending).rejects.toThrow(/abort/i);
  controller.abort();
  await rejection;
  expect(await readdir(run.hostPath)).toEqual([]);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    return url.hostname === "images.example" ? new Response("recovered") : url.pathname.endsWith("/thumbnail") ? thumbnail("first") : deck();
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).resolves.toMatchObject({ slides: [{ slideId: "first" }] });
});

it("times out a stalled image stream at 30 seconds and removes its partial output", async () => {
  const run = await setup();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 30_000 ? 30 : 500));
  let pulls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") return new Response(new ReadableStream({ pull(stream) {
      if (pulls++ === 0) stream.enqueue(new Uint8Array([1, 2, 3]));
      else return new Promise(() => {});
    } }));
    return url.pathname.endsWith("/thumbnail") ? thumbnail("first") : deck();
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).rejects.toThrow(/timeout/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it("enforces the 120 second deadline across a long render call and cleans completed slides", async () => {
  const run = await setup();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 120_000 ? 70 : 500));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/thumbnail") && url.hostname !== "images.example") {
      return Response.json({ slides: Array.from({ length: 15 }, (_, index) => ({ objectId: `slide-${index}` })) });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    return url.hostname === "images.example" ? new Response("PNG") : thumbnail(url.pathname.split("/").at(-2)!);
  }));
  await expect(run.execute({ presentationId: "deck" })).rejects.toThrow(/timeout/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it.each(["http", "network", "stream"])("reports a failed %s image download without exposing its signed URL and removes this call's files", async (failure) => {
  const run = await setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") {
      if (url.pathname === "/first") return new Response("complete PNG");
      if (failure === "http") return new Response("private signed=private", { status: 403 });
      if (failure === "network") throw new Error(`Failed to fetch ${input}`);
      return new Response(new ReadableStream({ start(stream) { stream.error(new Error(`Failed to read ${input}`)); } }));
    }
    return url.pathname.endsWith("/thumbnail") ? thumbnail(url.pathname.includes("/first/") ? "first" : "second") : deck();
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first", "second"] })).rejects.toMatchObject({
    status: failure === "http" ? 403 : 502,
    message: expect.stringMatching(/image download failed/i),
  });
  try { await run.execute({ presentationId: "deck", slideIds: ["second"] }); }
  catch (error) { expect(String(error)).not.toMatch(/images\.example|signed=private/); }
  expect(await readdir(run.hostPath)).toEqual([]);
});

it("limits the whole thumbnail request including retry delays to 30 seconds", async () => {
  const run = await setup();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 30_000 ? 30 : 500));
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") return new Response("PNG");
    if (!url.pathname.endsWith("/thumbnail")) return deck();
    if (attempts++ < 2) return new Response("rate limited", { status: 429, headers: { "retry-after": "0.02" } });
    return thumbnail("first");
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).rejects.toThrow(/abort|timeout/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it("renders slides concurrently with at most three requests active and retains presentation order", async () => {
  const run = await setup();
  let active = 0;
  let peak = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/thumbnail") && url.hostname !== "images.example") {
      return Response.json({ slides: Array.from({ length: 8 }, (_, index) => ({ objectId: `slide-${index}` })) });
    }
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, url.pathname.includes("slide-0") ? 10 : 1));
    active -= 1;
    return url.hostname === "images.example" ? new Response("PNG") : thumbnail(url.pathname.split("/").at(-2)!);
  }));
  const result = await run.execute({ presentationId: "deck" }) as { slides: Array<{ slideId: string; slideNumber: number }> };
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(3);
  expect(result.slides.map(slide => slide.slideId)).toEqual(["slide-0", "slide-1", "slide-2", "slide-3", "slide-4", "slide-5", "slide-6", "slide-7"]);
  expect(result.slides.map(slide => slide.slideNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it("retries thumbnail rate limits twice, then returns rate_limited with no files", async () => {
  const run = await setup();
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (!new URL(input).pathname.endsWith("/thumbnail")) return deck();
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: "Thumbnail quota exhausted" } }), { status: 429, headers: { "retry-after": "0" } });
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).resolves.toMatchObject({ reason: "rate_limited" });
  expect(attempts).toBe(3);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it("waits for in-flight downloads to stop before removing every file after a later slide fails", async () => {
  const run = await setup();
  let fail!: () => void;
  const failure = new Promise<void>(resolve => { fail = resolve; });
  let cancelled = false;
  let pulls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") {
      if (url.pathname === "/first") return new Response("complete PNG");
      return new Response(new ReadableStream({ pull(stream) {
        if (pulls++ === 0) stream.enqueue(new Uint8Array([1, 2, 3]));
        else return new Promise(() => {});
      }, cancel() { cancelled = true; } }));
    }
    if (!url.pathname.endsWith("/thumbnail")) return deck();
    if (url.pathname.includes("/second/")) {
      await failure;
      return new Response(JSON.stringify({ error: { message: "Slide unavailable" } }), { status: 404 });
    }
    return thumbnail(url.pathname.includes("/first/") ? "first" : "third");
  }));
  const pending = run.execute({ presentationId: "deck" });
  const rejection = expect(pending).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Slide unavailable") });
  await vi.waitFor(async () => {
    const first = (await readdir(run.hostPath)).find(file => file.endsWith("-slide-1.png"));
    expect(first).toBeDefined();
    expect(await readFile(path.join(run.hostPath, first!), "utf8")).toBe("complete PNG");
  });
  fail();
  await rejection;
  expect(cancelled).toBe(true);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it.each(["thumbnail", "image"])("times out a stalled %s HTTP request and allows another render to complete", async (stage) => {
  const run = await setup();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 30_000 ? 25 : 500));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if ((stage === "image" && url.hostname === "images.example") || (stage === "thumbnail" && url.pathname.endsWith("/thumbnail"))) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return url.pathname.endsWith("/thumbnail") ? thumbnail("first") : deck();
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).rejects.toThrow(/timeout/i);
  expect(await readdir(run.hostPath)).toEqual([]);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    return url.hostname === "images.example" ? new Response("PNG") : url.pathname.endsWith("/thumbnail") ? thumbnail("first") : deck();
  }));
  await expect(run.execute({ presentationId: "deck", slideIds: ["first"] })).resolves.toMatchObject({ slides: [{ slideId: "first" }] });
});

it.each([undefined, []])("renders every slide when slideIds is %j", async (slideIds) => {
  const run = await setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    return url.hostname === "images.example" ? new Response("PNG") : url.pathname.endsWith("/thumbnail") ? thumbnail(url.pathname.split("/").at(-2)!) : deck();
  }));
  await expect(run.execute({ presentationUrl: "https://drive.google.com/file/d/deck/view", slideIds })).resolves.toMatchObject({
    presentationId: "deck", slides: [{ slideId: "first", slideNumber: 1 }, { slideId: "second", slideNumber: 2 }, { slideId: "third", slideNumber: 3 }],
  });
});

it("rejects an unknown slide before requesting thumbnails", async () => {
  const run = await setup();
  const fetcher = vi.fn(async () => deck());
  vi.stubGlobal("fetch", fetcher);
  await expect(run.execute({ presentationId: "deck", slideIds: ["missing"] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("missing") });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readdir(run.hostPath)).toEqual([]);
});

it("returns an empty render list for a deck without slides", async () => {
  const run = await setup();
  const fetcher = vi.fn(async () => Response.json({ slides: [] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(run.execute({ presentationId: "deck" })).resolves.toEqual({ presentationId: "deck", slides: [], contactSheet: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readdir(run.hostPath)).toEqual([]);
});
