import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import extension from "./index.js";
import { fromBuffer } from "yauzl";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function tools(allowWrite = true) {
  const hostPath = await mkdtemp(path.join(tmpdir(), "drive-slides-")); roots.push(hostPath);
  const mounted = await extension.getAgentTools({ id: "agent", extensions: { googleDrive: { allowWrite } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test-token", scopes: [] }),
  });
  const context = { agentId: "agent", conversationFiles: { hostPath, runtimePath: "/workspace/files" } };
  return { hostPath, mounted, execute(name: string, params: unknown) {
    const tool = mounted.find(item => item.name === `googleDrive_${name}`);
    if (!tool) throw new Error(`Tool ${name} unavailable`);
    return tool.execute(params, context);
  } };
}
const pageSize = { width: { magnitude: 720, unit: "PT" }, height: { magnitude: 405, unit: "PT" } };
function deck(slides: unknown[] = [], extra = {}) { return { presentationId: "deck-1", title: "Brand", pageSize, slides, revisionId: "revision-1", ...extra }; }
function google(...responses: Response[]) {
  const pending = [...responses];
  const fetch = vi.fn(async () => { const response = pending.shift(); if (!response) throw new Error("Unexpected request"); return response; });
  vi.stubGlobal("fetch", fetch); return fetch;
}
it("creates a native deck in the requested folder, then inspects the actual empty slide list", async () => {
  const run = await tools();
  const fetch = google(Response.json({ id: "deck-1", webViewLink: "https://docs.google.com/presentation/d/deck-1/edit" }), Response.json(deck()));
  await expect(run.execute("slides_create", { title: "Brand", parentId: "folder-1" })).resolves.toEqual({
    presentationId: "deck-1", webViewLink: "https://docs.google.com/presentation/d/deck-1/edit", pageSize: { width: 720, height: 405, unit: "PT" }, slideIds: [], revisionId: "revision-1", slides: [],
  });
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(JSON.parse(calls[0][1].body as string)).toEqual({ name: "Brand", mimeType: "application/vnd.google-apps.presentation", parents: ["folder-1"] });
  expect(calls[0][1].method).toBe("POST");
  expect(calls[1][0]).toBe("https://slides.googleapis.com/v1/presentations/deck-1");
});
it("returns the created deck identity when inspection fails without creating a second deck", async () => {
  const run = await tools();
  const fetch = google(Response.json({ id: "deck-1" }), Response.json({ error: { message: "Slides API not enabled" } }, { status: 403 }));
  await expect(run.execute("slides_create", { title: "Brand" })).resolves.toMatchObject({ presentationId: "deck-1", webViewLink: "https://docs.google.com/presentation/d/deck-1/edit", pageSize: null, slideIds: [], revisionId: null, inspectionError: { message: expect.stringContaining("Slides API not enabled"), status: 403 } });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("reads an overview in presentation order from a Drive URL with page size and revision", async () => {
  const run = await tools(false);
  google(Response.json(deck([{ objectId: "second-file", slideProperties: { layoutObjectId: "layout-1" }, pageElements: [{ objectId: "text-1", shape: { text: { textElements: [{ textRun: { content: "Hello brand" } }] } } }] }], { masters: [{ objectId: "master-1", masterProperties: { displayName: "Main" } }], layouts: [{ objectId: "layout-1", layoutProperties: { displayName: "Title" } }] })));
  await expect(run.execute("slides_get", { presentationUrl: "https://drive.google.com/file/d/deck-1/view" })).resolves.toEqual({ presentationId: "deck-1", title: "Brand", pageSize: { width: 720, height: 405, unit: "PT" }, revisionId: "revision-1", masters: [{ id: "master-1", name: "Main" }], layouts: [{ id: "layout-1", name: "Title" }], slides: [{ slideId: "second-file", slideNumber: 1, layoutId: "layout-1", text: "Hello brand" }], truncated: false, nextSlideId: null });
});
it("returns selected slide details in presentation order including styles, groups, tables, notes and truncated text", async () => {
  const run = await tools(false);
  const shape = { objectId: "title", size: { width: { magnitude: 100, unit: "PT" } }, transform: { scaleX: 1, translateX: 24 }, shape: { text: { textElements: [{ textRun: { content: "x".repeat(2100), style: { fontFamily: "Montserrat" } } }] } } };
  google(Response.json(deck([{ objectId: "s1", pageElements: [{ objectId: "group", elementGroup: { children: [shape] } }, { objectId: "table", table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "Revenue" } }] } }] }] } }], slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "notes-1" }, pageElements: [{ objectId: "notes-1", shape: { text: { textElements: [{ textRun: { content: "Speaker notes" } }] } } }] } } }, { objectId: "s2" }], { revisionId: undefined })));
  const result = await run.execute("slides_get", { presentationId: "deck-1", slideIds: ["s2", "s1"] }) as { revisionId: unknown; slides: Record<string, unknown>[] };
  expect(result.revisionId).toBeNull();
  expect(result.slides.map(slide => [slide.slideId, slide.slideNumber])).toEqual([["s1", 1], ["s2", 2]]);
  expect(result.slides[0]).toMatchObject({ notes: { objectId: "notes-1", text: "Speaker notes" }, elements: [{ id: "group", type: "group", children: [{ id: "title", type: "shape", size: shape.size, transform: shape.transform, text: "x".repeat(2000), textTruncated: true, textElements: [{ textRun: { content: "x".repeat(2000), style: { fontFamily: "Montserrat" } } }] }] }, { id: "table", type: "table", table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "Revenue" } }] } }] }] } }] });
});
it("keeps overview JSON under 40000 characters and continues inclusively without losing slides", async () => {
  const run = await tools(false);
  const slides = Array.from({ length: 200 }, (_, i) => ({ objectId: `slide-${i}`, pageElements: [{ objectId: `shape-${i}`, shape: { text: { textElements: [{ textRun: { content: "Brand ".repeat(100) } }] } } }] }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(deck(slides))));
  const seen: string[] = []; let nextSlideId: string | null = null; let calls = 0;
  do {
    const result = await run.execute("slides_get", { presentationId: "deck-1", ...(nextSlideId ? { startSlideId: nextSlideId } : {}) }) as { slides: { slideId: string; text: string }[]; nextSlideId: string | null; truncated: boolean };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(40000);
    expect(result.slides.length).toBeGreaterThan(0);
    expect(result.slides.every(slide => slide.text.length <= 300)).toBe(true);
    seen.push(...result.slides.map(slide => slide.slideId)); nextSlideId = result.nextSlideId;
    expect(result.truncated).toBe(Boolean(nextSlideId)); calls++;
    if (calls > 10) throw new Error("Continuation did not advance");
  } while (nextSlideId);
  expect(calls).toBeGreaterThan(1);
  expect(seen).toEqual(slides.map(slide => slide.objectId));
});
it("passes arbitrary Google requests unchanged and guards edits with the revision read from Google", async () => {
  const run = await tools();
  const request = { updateTextStyle: { objectId: "shape-1", style: { fontFamily: "Montserrat", futureNestedProperty: { enabled: true } }, fields: "*" } };
  const fetch = google(Response.json(deck()), Response.json({ replies: [{ updated: true }], writeControl: { requiredRevisionId: "revision-2" } }));
  const read = await run.execute("slides_get", { presentationId: "deck-1" }) as { revisionId: string };
  await expect(run.execute("slides_batch_update", { presentationUrl: "https://docs.google.com/presentation/d/deck-1/edit", requests: [request], requiredRevisionId: read.revisionId })).resolves.toEqual({ presentationId: "deck-1", replies: [{ updated: true }], revisionId: "revision-2" });
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls[1][0]).toBe("https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate");
  expect(JSON.parse(calls[1][1].body as string)).toEqual({ requests: [request], writeControl: { requiredRevisionId: "revision-1" } });
});
it.each([{ requests: [] }, { requests: [null] }, { requests: ["bad"] }, { requests: [2] }])("rejects malformed batch request envelope with status400: %j", async ({ requests }) => {
  const run = await tools(); google();
  await expect(run.execute("slides_batch_update", { presentationId: "deck-1", requests })).rejects.toMatchObject({ status: 400 });
});

async function zipFiles(bytes: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const entries: Record<string, string> = {};
    zip.on("error", reject); zip.on("end", () => resolve(entries));
    zip.on("entry", entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(chunk)); stream.on("error", reject);
      stream.on("end", () => { entries[entry.fileName] = Buffer.concat(chunks).toString(); zip.readEntry(); });
    })); zip.readEntry();
  }));
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWPoTNX2AwAD/AFoZDjEbgAAAABJRU5ErkJggg==", "base64");
it("imports a local logo as a 16:9 native deck, with an aspect-preserving centered box and input slide order", async () => {
  const run = await tools(); await writeFile(path.join(run.hostPath, "logo.png"), png);
  let files: Record<string, string> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("uploadType=multipart")) {
      const body = Buffer.from(await new Response(init.body).arrayBuffer());
      expect(body.toString()).toContain('"name":"Brand"'); expect(body.toString()).toContain('"parents":["folder-1"]');
      expect(body.toString()).toContain('"mimeType":"application/vnd.google-apps.presentation"');
      expect(body.toString()).toContain("Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation");
      const start = body.indexOf(Buffer.from([80, 75, 3, 4]));
      const boundary = /boundary=([^;]+)/.exec(new Headers(init.headers).get("Content-Type")!)![1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      files = await zipFiles(body.subarray(start, end));
      return Response.json({ id: "deck-1" });
    }
    return Response.json(deck([{ objectId: "logo-slide" }, { objectId: "blank-slide" }]));
  }));
  await expect(run.execute("slides_create", { title: "Brand", parentId: "folder-1", slides: [{ images: [{ path: "/workspace/files/logo.png", x: 72, y: 72, width: 144, height: 72 }] }, { images: [] }] })).resolves.toMatchObject({ presentationId: "deck-1", slideIds: ["logo-slide", "blank-slide"] });
  expect(files["ppt/presentation.xml"]).toContain('<p:sldSz cx="9144000" cy="5143500"');
  expect(files["ppt/slides/slide1.xml"]).toContain('<a:off x="1371600" y="914400"/>');
  expect(files["ppt/slides/slide1.xml"]).toContain('<a:ext cx="914400" cy="914400"/>');
  expect(files["ppt/slides/slide2.xml"]).not.toContain("<p:pic>");
});
it.each([
  { title: "SVG", source: "logo.svg", bytes: Buffer.from('<svg width="2" height="2" xmlns="http://www.w3.org/2000/svg"/>'), status: 400, message: /PNG|JPEG|GIF/ },
  { title: "Large", source: "logo.png", bytes: Buffer.alloc(10_000_001), status: 413, message: /10 MB/ },
])("rejects $title local images before creating any deck", async ({ source, bytes, status, message }) => {
  const run = await tools(); await writeFile(path.join(run.hostPath, source), bytes); const fetch = google();
  await expect(run.execute("slides_create", { title: "Brand", slides: [{ images: [{ path: `/workspace/files/${source}`, x: 0, y: 0, width: 100, height: 100 }] }] })).rejects.toMatchObject({ status, message: expect.stringMatching(message) });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { slides: Array.from({ length: 51 }, () => ({ images: [] })), message: /50 slides/ },
  { slides: [{ images: Array.from({ length: 31 }, () => ({ path: "/workspace/files/logo.png", x: 0, y: 0, width: 10, height: 10 })) }], message: /30 images/ },
])("rejects hybrid slide or image counts beyond the declared limits", async ({ slides, message }) => {
  const run = await tools(); const fetch = google();
  await expect(run.execute("slides_create", { title: "Brand", slides })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(message) });
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a generated PPTX above 50 MB before any upload", async () => {
  const run = await tools();
  const images = [];
  for (let i = 0; i < 7; i++) {
    const bytes = Buffer.alloc(8_000_000, i); png.copy(bytes);
    await writeFile(path.join(run.hostPath, `logo-${i}.png`), bytes);
    images.push({ path: `/workspace/files/logo-${i}.png`, x: 0, y: 0, width: 10, height: 10 });
  }
  const fetch = google();
  await expect(run.execute("slides_create", { title: "Brand", slides: [{ images }] })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/50 MB.*PPTX|PPTX.*50 MB/) });
  expect(fetch).not.toHaveBeenCalled();
});
it("uploads a hybrid PPTX above 5 MB with a resumable session", async () => {
  const run = await tools(); const image = Buffer.alloc(5_100_000); png.copy(image);
  await writeFile(path.join(run.hostPath, "logo.png"), image);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("uploadType=resumable")) {
      expect(JSON.parse(init.body as string)).toEqual({ name: "Brand", mimeType: "application/vnd.google-apps.presentation", parents: ["folder-1"] });
      expect(new Headers(init.headers).get("X-Upload-Content-Type")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
      return new Response(null, { headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1" } });
    }
    if (url.includes("upload_id=session-1")) {
      expect(init.method).toBe("PUT"); expect(Buffer.from(await new Response(init.body).arrayBuffer()).byteLength).toBeGreaterThan(5_000_000);
      return Response.json({ id: "deck-1" });
    }
    return Response.json(deck([{ objectId: "slide-1" }]));
  }); vi.stubGlobal("fetch", fetch);
  await expect(run.execute("slides_create", { title: "Brand", parentId: "folder-1", slides: [{ images: [{ path: "/workspace/files/logo.png", x: 0, y: 0, width: 72, height: 72 }] }] })).resolves.toMatchObject({ presentationId: "deck-1", slideIds: ["slide-1"] });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([
  { presentationId: "deck-1", presentationUrl: "https://docs.google.com/presentation/d/deck-1/edit" }, {},
  { presentationUrl: "https://attacker.test/presentation/d/deck-1/edit" },
])("rejects ambiguous or invalid presentation references before HTTP", async reference => {
  const run = await tools(); const fetch = google();
  await expect(run.execute("slides_get", reference)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
});
it.each(["https://docs.google.com/presentation/d/deck-1/edit", "https://drive.google.com/file/d/deck-1/view", "https://drive.google.com/open?id=deck-1"])("accepts deck URL %s", async presentationUrl => {
  const run = await tools(false); const fetch = google(Response.json(deck()));
  await expect(run.execute("slides_get", { presentationUrl, slideIds: [] })).resolves.toMatchObject({ slides: [], truncated: false, nextSlideId: null });
  expect((fetch.mock.calls as unknown as [string][])[0][0]).toBe("https://slides.googleapis.com/v1/presentations/deck-1");
});
it("names unknown slide IDs and unknown continuation IDs", async () => {
  const run = await tools(); google(Response.json(deck([{ objectId: "s1" }])), Response.json(deck([{ objectId: "s1" }])));
  await expect(run.execute("slides_get", { presentationId: "deck-1", slideIds: ["missing"] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("missing") });
  await expect(run.execute("slides_get", { presentationId: "deck-1", startSlideId: "bad-start" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("bad-start") });
});
it("reports an oversized single detailed slide and oversized deck metadata with actionable 413 errors", async () => {
  const run = await tools();
  google(Response.json(deck([{ objectId: "huge-slide", pageElements: Array.from({ length: 40 }, (_, i) => ({ objectId: `element-${i}`, shape: { text: { textElements: [{ textRun: { content: "x".repeat(2000) } }] } } })) }])), Response.json(deck([], { title: "T".repeat(40000) })));
  await expect(run.execute("slides_get", { presentationId: "deck-1", slideIds: ["huge-slide"] })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/huge-slide.*overview.*slides_render/) });
  await expect(run.execute("slides_get", { presentationId: "deck-1" })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/metadata alone/) });
});
it("returns Google stale revision errors as400 without an unguarded retry", async () => {
  const run = await tools(); const fetch = google(Response.json({ error: { message: "Revision revision-1 is stale" } }, { status: 400 }));
  await expect(run.execute("slides_batch_update", { presentationId: "deck-1", requiredRevisionId: "revision-1", requests: [{ deleteObject: { objectId: "shape-1" } }] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Revision revision-1 is stale") });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([400, 404])("preserves Google HTTP%s and message for bad requests", async status => {
  const run = await tools(); google(Response.json({ error: { message: "Missing shape shape-1" } }, { status }));
  await expect(run.execute("slides_get", { presentationId: "deck-1" })).rejects.toMatchObject({ status, message: expect.stringContaining("Missing shape shape-1") });
});
it("reports insufficient OAuth scope but keeps ordinary permission refusals actionable", async () => {
  const run = await tools();
  google(Response.json({ error: { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, { status: 403 }), Response.json({ error: { message: "You do not have access to this presentation", errors: [{ reason: "insufficientFilePermissions" }] } }, { status: 403 }));
  await expect(run.execute("slides_get", { presentationId: "deck-1" })).resolves.toMatchObject({ reason: "insufficient_scope", isError: true });
  await expect(run.execute("slides_get", { presentationId: "deck-1" })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("You do not have access") });
});
it("returns a null write revision when Google omits it and hides writes in read-only mode", async () => {
  const run = await tools(); google(Response.json({ replies: [] }));
  await expect(run.execute("slides_batch_update", { presentationId: "deck-1", requests: [{ createSlide: {} }] })).resolves.toMatchObject({ revisionId: null });
  const readonly = await tools(false);
  expect(readonly.mounted.map(tool => tool.name)).not.toContain("googleDrive_slides_create");
  expect(readonly.mounted.map(tool => tool.name)).not.toContain("googleDrive_slides_batch_update");
  expect(readonly.mounted.map(tool => tool.name)).toContain("googleDrive_slides_get");
});

it.each([
  { name: "logo.jpg", bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9RKKKK+TPcP/Z", "base64") },
  { name: "logo.gif", bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") },
])("imports valid local $name images", async ({ name, bytes }) => {
  const run = await tools(); await writeFile(path.join(run.hostPath, name), bytes);
  google(Response.json({ id: "deck-1", name: "Brand", mimeType: "application/vnd.google-apps.presentation" }), Response.json(deck([{ objectId: "slide-1" }])));
  await expect(run.execute("slides_create", { title: "Brand", slides: [{ images: [{ path: `/workspace/files/${name}`, x: 0, y: 0, width: 72, height: 72 }] }] })).resolves.toMatchObject({ presentationId: "deck-1", slideIds: ["slide-1"] });
});
it("rejects images outside the current conversation folder and invalid parent folders without creating another file", async () => {
  const run = await tools(); const other = await tools(); await writeFile(path.join(other.hostPath, "logo.png"), png);
  const fetch = google(Response.json({ error: { message: "Folder not found: folder-1" } }, { status: 404 }));
  await expect(run.execute("slides_create", { title: "Brand", slides: [{ images: [{ path: path.join(other.hostPath, "logo.png"), x: 0, y: 0, width: 72, height: 72 }] }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/outside.*conversation/) });
  expect(fetch).not.toHaveBeenCalled();
  await expect(run.execute("slides_create", { title: "Brand", parentId: "folder-1" })).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Folder not found") });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("returns a thirty-slide overview in one response", async () => {
  const run = await tools(false);
  google(Response.json(deck(Array.from({ length: 30 }, (_, index) => ({ objectId: `slide-${index}`, pageElements: [{ objectId: `shape-${index}`, shape: { text: { textElements: [{ textRun: { content: "Brand message ".repeat(200) } }] } } }] })))));
  const result = await run.execute("slides_get", { presentationId: "deck-1" }) as { slides: unknown[]; truncated: boolean; nextSlideId: unknown };
  expect(result.slides).toHaveLength(30); expect(result.truncated).toBe(false); expect(result.nextSlideId).toBeNull();
});
it("continues selected details under the hard 60000-character budget with long IDs", async () => {
  const run = await tools(false);
  const ids = Array.from({ length: 25 }, (_, i) => `slide_${String(i).padStart(3, "0")}_${"x".repeat(40)}`);
  const slides = ids.map(objectId => ({ objectId, pageElements: [{ objectId: `shape-${objectId}`, shape: { text: { textElements: [{ textRun: { content: "T".repeat(2000), style: { fontFamily: "Montserrat" } } }] } } }] }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(deck(slides))));
  const seen: string[] = []; let next: string | null = null;
  do {
    const result = await run.execute("slides_get", { presentationId: "deck-1", slideIds: [...ids].reverse(), ...(next ? { startSlideId: next } : {}) }) as { slides: { slideId: string }[]; nextSlideId: string | null };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(60000); expect(result.slides.length).toBeGreaterThan(0);
    seen.push(...result.slides.map(slide => slide.slideId)); next = result.nextSlideId;
    if (seen.length > 25) throw new Error("Continuation repeated slides");
  } while (next);
  expect(seen).toEqual(ids);
});
it.each([
  { name: "slides_get", params: { presentationId: "deck-1" }, recovery: deck() },
  { name: "slides_batch_update", params: { presentationId: "deck-1", requests: [{ createSlide: {} }] }, recovery: { replies: [] } },
])("times out a hung $name request and allows the next call to progress", async ({ name, params, recovery }) => {
  const run = await tools(); const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }); })));
  await expect(run.execute(name, params)).rejects.toThrow(/timeout/i);
  google(Response.json(recovery));
  await expect(run.execute(name, params)).resolves.toMatchObject({ presentationId: "deck-1" });
});
