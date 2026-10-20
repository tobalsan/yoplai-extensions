import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it, vi } from "vitest";
import { fromBuffer } from "yauzl";
import extension from "../index.js";
import { buildElementRequests } from "../slides-elements.js";
import { SlideElementSchema, type SlideElementInput } from "../slides-models.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const hostPath = await mkdtemp(path.join(tmpdir(), "slides-authoring-")); roots.push(hostPath);
  const mounted = await extension.getAgentTools({ id: "agent", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test-token", scopes: [] }),
  });
  const context = { agentId: "agent", conversationFiles: { hostPath, runtimePath: "/workspace/files" } };
  return { hostPath, execute: (name: string, params: unknown) => mounted.find(tool => tool.name === `googleDrive_${name}`)!.execute(params, context) };
}
const el = (input: unknown) => SlideElementSchema.parse(input);
function zipFiles(bytes: Buffer): Promise<Record<string, string>> {
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

it("builds PT geometry, color floats and field masks only for given props", () => {
  const { requests, elementIds } = buildElementRequests("slide-1", [
    el({ kind: "text", id: "title-1", x: 10, y: 20, w: 300, h: 40, text: "Hi", font: "Inter", size: 24, bold: true, color: "#ff0000", align: "center", valign: "middle", lineSpacing: 115 }),
    el({ kind: "rect", x: 0, y: 0, w: 5, h: 5 }),
    el({ kind: "ellipse", x: 0, y: 0, w: 5, h: 5, fill: "00ff00", outline: { color: "0000FF", weight: 2 } }),
  ]);
  expect(elementIds[0]).toBe("title-1");
  expect(elementIds[1].length).toBeGreaterThanOrEqual(5);
  expect(requests[0]).toEqual({ createShape: { objectId: "title-1", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "slide-1", size: { width: { magnitude: 300, unit: "PT" }, height: { magnitude: 40, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: "PT" } } } });
  expect(requests[1]).toEqual({ updateShapeProperties: { objectId: "title-1", shapeProperties: { contentAlignment: "MIDDLE" }, fields: "contentAlignment" } });
  expect(requests[2]).toEqual({ insertText: { objectId: "title-1", text: "Hi", insertionIndex: 0 } });
  expect(requests[3]).toEqual({ updateTextStyle: { objectId: "title-1", textRange: { type: "ALL" }, style: { fontFamily: "Inter", fontSize: { magnitude: 24, unit: "PT" }, bold: true, foregroundColor: { opaqueColor: { rgbColor: { red: 1, green: 0, blue: 0 } } } }, fields: "fontFamily,fontSize,bold,foregroundColor" } });
  expect(requests[4]).toEqual({ updateParagraphStyle: { objectId: "title-1", textRange: { type: "ALL" }, style: { alignment: "CENTER", lineSpacing: 115 }, fields: "alignment,lineSpacing" } });
  expect(requests[6]).toMatchObject({ updateShapeProperties: { shapeProperties: { outline: { propertyState: "NOT_RENDERED" } }, fields: "outline.propertyState" } });
  expect(requests[8]).toMatchObject({ updateShapeProperties: { shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 0, green: 1, blue: 0 } } } }, outline: { outlineFill: { solidFill: { color: { rgbColor: { red: 0, green: 0, blue: 1 } } } }, weight: { magnitude: 2, unit: "PT" } } }, fields: "shapeBackgroundFill.solidFill.color,outline.outlineFill.solidFill.color,outline.weight" } });
});
it("builds line and image requests and rejects radius and local paths before any API call", () => {
  const { requests } = buildElementRequests("s1", [el({ kind: "line", id: "line-1", x: 0, y: 10, w: 100, h: 0, outline: { color: "#112233", weight: 3 } }), el({ kind: "image", id: "img-1", x: 1, y: 2, w: 3, h: 4, url: "https://example.com/a.png" })]);
  expect(requests).toMatchObject([{ createLine: { objectId: "line-1", lineCategory: "STRAIGHT" } }, { updateLineProperties: { objectId: "line-1", lineProperties: { weight: { magnitude: 3, unit: "PT" } }, fields: "lineFill.solidFill.color,weight" } }, { createImage: { objectId: "img-1", url: "https://example.com/a.png" } }]);
  expect(() => buildElementRequests("s1", [el({ kind: "roundRect", x: 0, y: 0, w: 5, h: 5, radius: 4 })])).toThrow(/cannot set corner radius/);
  expect(() => buildElementRequests("s1", [el({ kind: "image", x: 0, y: 0, w: 5, h: 5, path: "/workspace/files/a.png" })])).toThrow(/slides_create/);
});
it("validates element kinds", () => {
  const bad = (input: unknown) => expect(SlideElementSchema.safeParse(input).success).toBe(false);
  bad({ kind: "rect", x: 0, y: 0, w: 5, h: 5, radius: 3 }); bad({ kind: "image", x: 0, y: 0, w: 5, h: 5 }); bad({ kind: "line", x: 0, y: 0, w: 5, h: 5, text: "x" });
  bad({ kind: "rect", x: 0, y: 0, w: 0, h: 5 }); bad({ kind: "rect", id: "ab", x: 0, y: 0, w: 1, h: 1 }); bad({ kind: "rect", id: "-abcde", x: 0, y: 0, w: 1, h: 1 }); bad({ kind: "rect", id: "a".repeat(51), x: 0, y: 0, w: 1, h: 1 }); bad({ kind: "rect", x: 0, y: 0, w: 1, h: 1, fill: "red" });
  expect(SlideElementSchema.parse({ kind: "line", x: 0, y: 0, w: 5, h: 0, color: "#abcdef" })).toMatchObject({ color: "ABCDEF" });
});
it("slides_add_elements sends one guarded batch with a new blank slide and renders without hiding edit failures", async () => {
  const run = await setup();
  const fetcher = vi.fn(async (url: string) => url.endsWith(":batchUpdate") ? Response.json({ replies: [], writeControl: { requiredRevisionId: "rev-2" } }) : Response.json({ error: { message: "boom" } }, { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  const result = await run.execute("slides_add_elements", { presentationId: "deck", newSlide: { insertionIndex: 1 }, elements: [{ kind: "text", id: "t-1234", x: 1, y: 2, w: 3, h: 4, text: "A" }], requiredRevisionId: "rev-1", render: true }) as { slideId: string; elementIds: string[]; revisionId: string; renderError?: { message: string } };
  expect(result).toMatchObject({ presentationId: "deck", elementIds: ["t-1234"], revisionId: "rev-2", renderError: { message: expect.any(String) } });
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.writeControl).toEqual({ requiredRevisionId: "rev-1" });
  expect(body.requests[0]).toEqual({ createSlide: { objectId: result.slideId, insertionIndex: 1, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  await expect(run.execute("slides_add_elements", { presentationId: "deck", slideId: "s1", newSlide: {}, elements: [{ kind: "rect", x: 0, y: 0, w: 1, h: 1 }] })).rejects.toMatchObject({ status: 400 });
  await expect(run.execute("slides_add_elements", { presentationId: "deck", elements: [{ kind: "roundRect", x: 0, y: 0, w: 1, h: 1, radius: 2 }] })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("slides_batch_update reads requestsPath arrays and { requests }, normalizes containsText, and enforces XOR", async () => {
  const run = await setup();
  const fetcher = vi.fn(async () => Response.json({ replies: [{}] }));
  vi.stubGlobal("fetch", fetcher);
  await writeFile(path.join(run.hostPath, "a.json"), JSON.stringify([{ replaceAllText: { containsText: "{{x}}", replaceText: "1" } }]));
  await writeFile(path.join(run.hostPath, "b.json"), JSON.stringify({ requests: [{ createSlide: {} }] }));
  await writeFile(path.join(run.hostPath, "bad.json"), "{nope"); await writeFile(path.join(run.hostPath, "empty.json"), "[]");
  await run.execute("slides_batch_update", { presentationId: "deck", requestsPath: "/workspace/files/a.json" });
  await run.execute("slides_batch_update", { presentationId: "deck", requestsPath: "/workspace/files/b.json" });
  const bodies = (fetcher.mock.calls as unknown as [string, RequestInit][]).map(call => JSON.parse(call[1].body as string));
  expect(bodies[0].requests).toEqual([{ replaceAllText: { containsText: { text: "{{x}}", matchCase: true }, replaceText: "1" } }]);
  expect(bodies[1].requests).toEqual([{ createSlide: {} }]);
  for (const params of [{ requestsPath: "/workspace/files/bad.json" }, { requestsPath: "/workspace/files/empty.json" }, {}, { requests: [{ createSlide: {} }], requestsPath: "/workspace/files/b.json" }]) {
    await expect(run.execute("slides_batch_update", { presentationId: "deck", ...params })).rejects.toMatchObject({ status: 400 });
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});
function solid(width: number, height: number, color: number) { const image = new PNG({ width, height }); image.data.fill(color); for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255; return PNG.sync.write(image); }
function renderFetch(sheetImage: () => Buffer | string) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "images.example") return new Response(new Uint8Array(Buffer.from(sheetImage())));
    if (url.pathname.endsWith("/thumbnail")) return Response.json({ contentUrl: `https://images.example/${url.pathname.split("/").at(-2)}`, width: 1600, height: 900 });
    if (url.pathname.endsWith(":batchUpdate")) return Response.json({ replies: [] });
    return Response.json({ slides: [{ objectId: "a" }, { objectId: "b" }, { objectId: "c" }] });
  });
}
it("renders a contact sheet for several slides, none for one, and batch_update renderSlideIds includes it", async () => {
  const run = await setup();
  vi.stubGlobal("fetch", renderFetch(() => solid(1600, 900, 0x40)));
  const many = await run.execute("slides_render", { presentationId: "deck" }) as { contactSheet: { path: string; columns: number; slideIds: string[] } };
  expect(many.contactSheet).toMatchObject({ columns: 2, slideIds: ["a", "b", "c"] });
  const sheet = PNG.sync.read(await readFile(path.join(run.hostPath, path.basename(many.contactSheet.path))));
  expect([sheet.width, sheet.height]).toEqual([1648, 2 * 450 + 3 * 16]);
  expect(sheet.data[0]).toBe(0xDD); expect(sheet.data[(16 * sheet.width + 16) * 4]).toBe(0x40);
  expect(sheet.data[((16 + 450 + 16 + 5) * sheet.width + 1648 - 20) * 4]).toBe(0xDD);
  await expect(run.execute("slides_render", { presentationId: "deck", slideIds: ["a"] })).resolves.toMatchObject({ contactSheet: null });
  const updated = await run.execute("slides_batch_update", { presentationId: "deck", requests: [{ createSlide: {} }], renderSlideIds: ["a", "b"] }) as { render: { contactSheet: { slideIds: string[] } } };
  expect(updated.render.contactSheet.slideIds).toEqual(["a", "b"]);
});
it("keeps individual renders when the contact sheet cannot be built", async () => {
  const run = await setup();
  vi.stubGlobal("fetch", renderFetch(() => "not a png"));
  const result = await run.execute("slides_render", { presentationId: "deck", slideIds: ["a", "b"] }) as { slides: unknown[]; contactSheet: null; contactSheetError: string };
  expect(result.slides).toHaveLength(2); expect(result.contactSheet).toBeNull(); expect(result.contactSheetError).toEqual(expect.any(String));
  expect(await readdir(run.hostPath)).toHaveLength(2);
});
const sampleSlides = [
  { background: "#F5F7FA", notes: "Opening notes", elements: [
    { kind: "roundRect", x: 40, y: 60, w: 300, h: 200, radius: 20, fill: "#FFFFFF", outline: { color: "#CCCCCC", weight: 1 }, text: "Card body", size: 14, color: "#333333" },
    { kind: "text", x: 40, y: 20, w: 640, h: 36, text: "Quarterly review", font: "Inter", size: 28, bold: true, color: "#111111", lineSpacing: 115 },
    { kind: "ellipse", x: 400, y: 100, w: 80, h: 80, fill: "#FF6600" }, { kind: "line", x: 40, y: 280, w: 640, h: 0, color: "#999999" },
  ] },
  { elements: [{ kind: "text", x: 40, y: 20, w: 640, h: 36, text: "Second slide" }, { kind: "roundRect", x: 40, y: 80, w: 100, h: 100, radius: 0, fill: "#EEEEEE" }] },
];
it("slides_create draws point elements, radius, background and notes into the imported PPTX and reports element ids", async () => {
  const run = await setup();
  let files: Record<string, string> = {}; let pptx = Buffer.alloc(0);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("uploadType=multipart")) {
      const body = Buffer.from(await new Response(init.body).arrayBuffer());
      const boundary = /boundary=([^;]+)/.exec(new Headers(init.headers).get("Content-Type")!)![1];
      pptx = body.subarray(body.indexOf(Buffer.from([80, 75, 3, 4])), body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`)));
      files = await zipFiles(pptx);
      return Response.json({ id: "deck-1" });
    }
    return Response.json({ presentationId: "deck-1", slides: [{ objectId: "s1", pageElements: [{ objectId: "e1" }, { objectId: "e2" }] }, { objectId: "s2" }] });
  }));
  const result = await run.execute("slides_create", { title: "Sample", slides: sampleSlides });
  expect(result).toMatchObject({ slides: [{ slideId: "s1", elementIds: ["e1", "e2"] }, { slideId: "s2", elementIds: [] }] });
  const slide1 = files["ppt/slides/slide1.xml"];
  expect(slide1).toContain('prst="roundRect"');
  expect(slide1).toMatch(/<a:gd name="adj" fmla="val 10000"\/>/); // 20pt on a 200pt short side
  expect(slide1).toContain("Card body"); expect(slide1).toContain("Quarterly review"); expect(slide1).toContain('<a:srgbClr val="FF6600"/>'); expect(slide1).toContain('prst="ellipse"');
  expect(slide1).toContain('prst="line"'); expect(slide1).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5F7FA"/>');
  expect(slide1).toContain('typeface="Inter"'); expect(slide1).toContain('<a:spcPct val="115000"/>');
  expect(Object.values(files).some(content => content.includes("Opening notes"))).toBe(true);
  expect(files["ppt/slides/slide2.xml"]).toContain('prst="rect"');
});
it("slides_create counts element images toward the 30 image limit and rejects URL images", async () => {
  const run = await setup(); await writeFile(path.join(run.hostPath, "logo.png"), png);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const image: SlideElementInput = el({ kind: "image", x: 0, y: 0, w: 10, h: 10, path: "/workspace/files/logo.png" });
  await expect(run.execute("slides_create", { title: "T", slides: [{ elements: Array.from({ length: 31 }, () => image) }] })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/30 images/) });
  await expect(run.execute("slides_create", { title: "T", slides: [{ elements: [{ kind: "image", x: 0, y: 0, w: 10, h: 10, url: "https://example.com/a.png" }] }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/slides_add_elements/) });
  expect(fetcher).not.toHaveBeenCalled();
});
it("slides_create ignores short element ids and resolves bare image file names in the conversation folder", async () => {
  const run = await setup(); await writeFile(path.join(run.hostPath, "logo.png"), png);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("uploadType=multipart") ? Response.json({ id: "deck-1" }) : Response.json({ presentationId: "deck-1", slides: [{ objectId: "s1" }] })));
  const slides = [{ elements: [{ kind: "image", id: "i1", x: 0, y: 0, w: 10, h: 10, path: "logo.png" }, { kind: "text", id: "t1", x: 0, y: 20, w: 100, h: 20, text: "Hi" }] }];
  await expect(run.execute("slides_create", { title: "T", slides })).resolves.toMatchObject({ presentationId: "deck-1" });
  await expect(run.execute("slides_create", { title: "T", slides: [{ elements: [{ kind: "image", x: 0, y: 0, w: 10, h: 10, path: "sub/logo.png" }] }] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/conversation folder root/) });
});
