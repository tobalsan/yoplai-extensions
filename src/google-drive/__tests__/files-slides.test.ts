import { crc32, deflateRawSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tools() {
  const hostPath = await mkdtemp(path.join(process.cwd(), ".files-slides-"));
  roots.push(hostPath);
  const mounted = await extension.getAgentTools({ id: "agent", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "fake-token", scopes: [] }),
  });
  return { hostPath, execute(name: string, params: unknown) {
    const tool = mounted.find((item) => item.name === `googleDrive_${name}`)!;
    return tool.execute(params, { agentId: "agent", conversationFiles: { hostPath, runtimePath: "/workspace/files" } });
  } };
}
it.each([
  ["pptx", "presentation", "presentationml.presentation"],
  ["docx", "document", "wordprocessingml.document"],
  ["xlsx", "spreadsheet", "spreadsheetml.sheet"],
])("converts a new %s copy while preserving its Office media and folder", async (suffix, native, media) => {
  const run = await tools();
  await writeFile(path.join(run.hostPath, `source.${suffix}`), "Office bytes");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = Buffer.from(await new Response(init.body).arrayBuffer()).toString();
    expect(body).toContain(`"mimeType":"application/vnd.google-apps.${native}"`);
    expect(body).toContain('"name":"Native copy"');
    expect(body).toContain('"parents":["folder-1"]');
    expect(body).toContain(`Content-Type: application/vnd.openxmlformats-officedocument.${media}`);
    expect(body).toContain("Office bytes");
    return Response.json({ id: "copy", name: "Native copy", mimeType: `application/vnd.google-apps.${native}` });
  }));
  await expect(run.execute("save_file", { path: `/workspace/files/source.${suffix}`, name: "Native copy", parentId: "folder-1", convert: true })).resolves.toMatchObject({ fileId: "copy", mimeType: `application/vnd.google-apps.${native}` });
});
it.each([
  { path: "/workspace/files/source.pptx", fileId: "original" },
  { path: "/workspace/files/source.pdf", name: "Copy" },
])("refuses invalid native conversions before contacting Google: $path", async (params) => {
  const run = await tools();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Must not contact Google"); }));
  await expect(run.execute("save_file", { ...params, convert: true })).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["document", "spreadsheet", "presentation"])("exports a native %s as PDF into the conversation", async (native) => {
  const run = await tools();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/export")) {
      expect(url.searchParams.get("mimeType")).toBe("application/pdf");
      return new Response("%PDF-preview");
    }
    return Response.json({ id: "deck", name: "Deck", mimeType: `application/vnd.google-apps.${native}` });
  }));
  const result = await run.execute("download_file", { fileId: "deck", format: "pdf" }) as { path: string };
  expect(result).toMatchObject({ name: "Deck.pdf", mimeType: "application/pdf", bytes: 12 });
  expect(await readFile(path.join(run.hostPath, path.basename(result.path)), "utf8")).toBe("%PDF-preview");
});
it("rejects PDF export of binary media before downloading it", async () => {
  const run = await tools();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: "Existing.pdf", mimeType: "application/pdf" })));
  await expect(run.execute("download_file", { fileId: "binary", format: "pdf" })).rejects.toMatchObject({ status: 400 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

function zip(entries: Array<[string, string | Buffer]>) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename), bytes = Buffer.from(value);
    const compressed = deflateRawSync(bytes), checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(record, name); offset += local.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pptxGoogle(bytes: Buffer) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new URL(input).searchParams.get("alt") === "media"
    ? new Response(new Uint8Array(bytes))
    : Response.json({ id: "pptx", name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })));
}
it("reads PPTX slides in relationship order, including groups, table cells and related notes", async () => {
  const run = await tools();
  pptxGoogle(zip([
    ["ppt/presentation.xml", '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="9" r:id="second"/><p:sldId id="10" r:id="first"/></p:sldIdLst></p:presentation>'],
    ["ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="first" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="x/slide" Target="slides/slide7.xml"/></Relationships>'],
    ["ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><p:sp><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:sp></p:sld>'],
    ["ppt/slides/slide7.xml", '<p:sld xmlns:p="p" xmlns:a="a"><p:grpSp><p:sp><a:p><a:r><a:t>Group &amp; title</a:t></a:r></a:p></p:sp></p:grpSp><p:graphicFrame><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Cell one</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Cell two</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:graphicFrame></p:sld>'],
    ["ppt/slides/_rels/slide7.xml.rels", '<Relationships><Relationship Id="notes" Type="x/notesSlide" Target="../notesSlides/notesSlide3.xml"/></Relationships>'],
    ["ppt/notesSlides/notesSlide3.xml", '<p:notes xmlns:p="p" xmlns:a="a"><p:sp><a:p><a:r><a:t>Speaker guidance</a:t></a:r></a:p></p:sp></p:notes>'],
  ]));
  const result = await run.execute("read_file", { fileId: "pptx" }) as { text: string };
  expect(result.text).toBe("## Slide 1\nGroup & title\nCell one\nCell two\n\nNotes:\nSpeaker guidance\n\n## Slide 2\nLast slide");
});
it("stops PPTX media as soon as it passes the 25 MiB download limit", async () => {
  const run = await tools();
  let sent = 0;
  let canceled = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new URL(input).searchParams.get("alt") === "media"
    ? new Response(new ReadableStream({ pull(controller) { if (sent >= 30_000_000) return controller.close(); sent += 1_000_000; controller.enqueue(new Uint8Array(1_000_000)); }, cancel() { canceled = true; } }))
    : Response.json({ name: "large.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })));
  const pending = run.execute("read_file", { fileId: "large" });
  await expect(pending).rejects.toMatchObject({ status: 413, message: expect.stringContaining("25 MiB") });
  expect(canceled).toBe(true);
  expect(sent).toBeLessThanOrEqual(28_000_000);
});
it("rejects more than 2,000 ZIP entries even if their names are duplicated", async () => {
  const run = await tools();
  pptxGoogle(zip(Array.from({ length: 2001 }, () => ["duplicate.txt", "x"])));
  await expect(run.execute("read_file", { fileId: "pptx" })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("2,000") });
});
it("rejects a highly compressed entry over 20 MB before expanding it", async () => {
  const run = await tools();
  pptxGoogle(zip([["ppt/slides/slide1.xml", Buffer.alloc(20_000_001, 65)]]));
  await expect(run.execute("read_file", { fileId: "pptx" })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("20 MB") });
});
it("caps total inflated PPTX XML at 100 MB across otherwise valid entries", async () => {
  const run = await tools();
  const slides = Array.from({ length: 6 }, (_, index) => index + 1);
  const padding = `<!--${"x".repeat(17_000_000)}-->`;
  pptxGoogle(zip([
    ["ppt/presentation.xml", `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slides.map((n) => `<p:sldId id="${n}" r:id="r${n}"/>`).join("")}</p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships>${slides.map((n) => `<Relationship Id="r${n}" Type="x/slide" Target="slides/slide${n}.xml"/>`).join("")}</Relationships>`],
    ...slides.map((n): [string, string] => [`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="p">${padding}</p:sld>`]),
  ]));
  await expect(run.execute("read_file", { fileId: "pptx" })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("100 MB") });
});
it("stops a stalled PPTX body at timeout and permits the next read", async () => {
  const run = await tools();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
  let canceled = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new URL(input).searchParams.get("alt") === "media"
    ? new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } }))
    : Response.json({ name: "stalled.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })));
  const pending = run.execute("read_file", { fileId: "stalled" });
  await expect(run.execute("list_files", {})).resolves.toMatchObject({ files: [] });
  await expect(pending).rejects.toThrow(/timeout/i);
  expect(canceled).toBe(true);
  pptxGoogle(zip([["ppt/presentation.xml", '<p:presentation xmlns:p="p"/>']]));
  await expect(run.execute("read_file", { fileId: "recovered" })).resolves.toMatchObject({ text: "" });
});
it("reads a converted native deck whose name retains the .pptx suffix", async () => {
  const run = await tools();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new URL(input).pathname.endsWith("/export")
    ? new Response("Native slide text")
    : Response.json({ name: "converted.pptx", mimeType: "application/vnd.google-apps.presentation" })));
  await expect(run.execute("read_file", { fileId: "native" })).resolves.toMatchObject({ text: "Native slide text", exported: true });
});

it("reads slide and notes text through package-absolute PPTX relationships", async () => {
  const run = await tools();
  pptxGoogle(zip([
    ["ppt/presentation.xml", '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="first"/></p:sldIdLst></p:presentation>'],
    ["ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="first" Type="x/slide" Target="/ppt/slides/slide1.xml"/></Relationships>'],
    ["ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><p:sp><a:p><a:r><a:t>Visible title</a:t></a:r></a:p></p:sp></p:sld>'],
    ["ppt/slides/_rels/slide1.xml.rels", '<Relationships><Relationship Id="notes" Type="x/notesSlide" Target="/ppt/notesSlides/notesSlide1.xml"/></Relationships>'],
    ["ppt/notesSlides/notesSlide1.xml", '<p:notes xmlns:p="p" xmlns:a="a"><p:sp><a:p><a:r><a:t>Visible notes</a:t></a:r></a:p></p:sp></p:notes>'],
  ]));
  await expect(run.execute("read_file", { fileId: "pptx" })).resolves.toMatchObject({ text: "## Slide 1\nVisible title\n\nNotes:\nVisible notes" });
});
