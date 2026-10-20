import path from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { XMLParser } from "fast-xml-parser";

class PptxLimitError extends Error { readonly status = 413; }
const ENTRY_LIMIT = 20_000_000;
const TOTAL_LIMIT = 100_000_000;
type XmlNode = { [key: string]: XmlNode[] | string | Record<string, string> };
const xml = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, processEntities: true });
export async function readPptxResponse(response: Response): Promise<Buffer> {
  const signal = AbortSignal.timeout(30_000);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return Buffer.concat(chunks);
      size += chunk.value.byteLength;
      if (size > 25 * 1024 * 1024) throw new PptxLimitError("PPTX exceeds the 25 MiB file limit.");
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener("abort", cancel); }
}
function children(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes) for (const [tag, value] of Object.entries(node)) {
    if (tag === ":@" || !Array.isArray(value)) continue;
    if (tag.split(":").at(-1) === name) found.push(node);
    else found.push(...children(value, name));
  }
  return found;
}
function attrs(node: XmlNode): Record<string, string> { return node[":@"] as Record<string, string> ?? {}; }
function resolvePart(folder: string, target: string): string {
  return path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(folder, target));
}
function text(nodes: XmlNode[]): string {
  return children(nodes, "p").map((paragraph) => {
    const contents = Object.entries(paragraph).find(([key]) => key !== ":@")?.[1] as XmlNode[] ?? [];
    return children(contents, "t").map((node) => {
      const runs = Object.entries(node).find(([key]) => key !== ":@")?.[1] as XmlNode[] ?? [];
      return runs.map((run) => run["#text"] ?? "").join("");
    }).join("");
  }).filter(Boolean).join("\n");
}

/** Bounded ZIP extraction; slide and notes order comes from OOXML relationships. */
export async function extractPptxText(buffer: Buffer): Promise<string> {
  if (buffer.length > 25 * 1024 * 1024) throw new PptxLimitError("PPTX exceeds the 25 MiB file limit.");
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value!)));
  const entries = new Map<string, Entry>();
  let entryCount = 0;
  let total = 0;
  const cache = new Map<string, XmlNode[]>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        if (++entryCount > 2000) return reject(new PptxLimitError("PPTX exceeds the 2,000 ZIP entry limit."));
        if (entry.uncompressedSize > ENTRY_LIMIT) return reject(new PptxLimitError(`PPTX entry ${entry.fileName} exceeds the 20 MB inflated entry limit.`));
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    async function read(name: string): Promise<XmlNode[]> {
      const cached = cache.get(name);
      if (cached) return cached;
      const entry = entries.get(name);
      if (!entry) return [];
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        total += chunk.length;
        if (length > ENTRY_LIMIT) throw new PptxLimitError(`PPTX entry ${name} exceeds the 20 MB inflated entry limit.`);
        if (total > TOTAL_LIMIT) throw new PptxLimitError("PPTX exceeds the 100 MB total inflated limit.");
        chunks.push(Buffer.from(chunk));
      }
      const parsed = xml.parse(Buffer.concat(chunks).toString("utf8")) as XmlNode[];
      cache.set(name, parsed);
      return parsed;
    }
    const presentation = await read("ppt/presentation.xml");
    const relationships = children(await read("ppt/_rels/presentation.xml.rels"), "Relationship");
    const parts: string[] = [];
    for (const slide of children(presentation, "sldId")) {
      const reference = Object.entries(attrs(slide)).find(([key]) => key.endsWith(":id"))?.[1];
      const relationship = relationships.find((item) => attrs(item)["@_Id"] === reference);
      if (!relationship || attrs(relationship)["@_TargetMode"] === "External") continue;
      const slidePath = resolvePart("ppt", attrs(relationship)["@_Target"]);
      const slideText = text(await read(slidePath));
      const notesRels = children(await read(path.posix.join(path.posix.dirname(slidePath), "_rels", `${path.posix.basename(slidePath)}.rels`)), "Relationship");
      const notes = notesRels.find((item) => attrs(item)["@_Type"]?.endsWith("/notesSlide") && attrs(item)["@_TargetMode"] !== "External");
      const notesText = notes ? text(await read(resolvePart(path.posix.dirname(slidePath), attrs(notes)["@_Target"]))) : "";
      parts.push(`## Slide ${parts.length + 1}\n${slideText}${notesText ? `\n\nNotes:\n${notesText}` : ""}`);
    }
    return parts.join("\n\n");
  } finally { zip.close(); }
}
