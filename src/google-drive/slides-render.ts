import { open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { ToolExecutionContext } from "../tool-extension.js";
import type { DriveRequest } from "./files.js";
import { resolvePresentationId, selectSlides, SlidesError, type Presentation, type SlidePage } from "./slides.js";

export interface SlidesRenderParams { presentationId?: string; presentationUrl?: string; slideIds?: string[] }

const CONTACT_COLUMNS = 2, CONTACT_CELL_WIDTH = 800, CONTACT_GAP = 16, CONTACT_MAX_SLIDES = 12;
function scaled(source: PNG, width: number, height: number) {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * source.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * source.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / width));
      const sum = [0, 0, 0, 0]; let count = 0;
      for (let sy = y0; sy < Math.min(y1, source.height); sy++) for (let sx = x0; sx < Math.min(x1, source.width); sx++) {
        const i = (sy * source.width + sx) * 4, alpha = source.data[i + 3];
        for (let c = 0; c < 3; c++) sum[c] += source.data[i + c] * alpha;
        sum[3] += alpha; count++;
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0;
      out.data[o + 3] = Math.round(sum[3] / count);
    }
  }
  return out;
}
async function writeContactSheet(images: string[], destination: string) {
  const cells = await Promise.all(images.map(async file => {
    const png = PNG.sync.read(await readFile(file));
    return scaled(png, CONTACT_CELL_WIDTH, Math.max(1, Math.round(CONTACT_CELL_WIDTH * png.height / png.width)));
  }));
  const rows = Math.ceil(cells.length / CONTACT_COLUMNS);
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...cells.slice(row * CONTACT_COLUMNS, (row + 1) * CONTACT_COLUMNS).map(cell => cell.height)));
  const sheet = new PNG({ width: CONTACT_COLUMNS * CONTACT_CELL_WIDTH + (CONTACT_COLUMNS + 1) * CONTACT_GAP, height: rowHeights.reduce((sum, height) => sum + height, 0) + (rows + 1) * CONTACT_GAP });
  sheet.data.fill(0xDD); for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
  cells.forEach((cell, index) => {
    const row = Math.floor(index / CONTACT_COLUMNS), column = index % CONTACT_COLUMNS;
    const left = CONTACT_GAP + column * (CONTACT_CELL_WIDTH + CONTACT_GAP), top = CONTACT_GAP + rowHeights.slice(0, row).reduce((sum, height) => sum + height + CONTACT_GAP, 0);
    for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
      const from = (y * cell.width + x) * 4, to = ((top + y) * sheet.width + left + x) * 4, alpha = cell.data[from + 3] / 255;
      for (let c = 0; c < 3; c++) sheet.data[to + c] = Math.round(cell.data[from + c] * alpha + 0xDD * (1 - alpha));
    }
  });
  await writeFile(destination, PNG.sync.write(sheet), { flag: "wx", mode: 0o600 });
}

export async function renderSlides(params: SlidesRenderParams, context: ToolExecutionContext | undefined, request: DriveRequest) {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to render slides.");
  const failure = new AbortController();
  const signal = AbortSignal.any([failure.signal, ...(context.signal ? [context.signal] : []), AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  const files = context.conversationFiles;
  const presentationId = resolvePresentationId(params);
  const folder = await realpath(context.conversationFiles.hostPath);
  const base = `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`;
  const presentation = await (await request(base, { signal })).json() as Presentation;
  const selected = selectSlides(presentation.slides ?? [], params.slideIds);
  const created: string[] = [];
  async function render({ slide, slideNumber }: { slide: SlidePage; slideNumber: number }) {
    const url = new URL(`${base}/pages/${encodeURIComponent(slide.objectId)}/thumbnail`);
    url.searchParams.set("thumbnailProperties.mimeType", "PNG");
    url.searchParams.set("thumbnailProperties.thumbnailSize", "LARGE");
    const thumbnailSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const thumbnail = await (await request(url.toString(), { signal: thumbnailSignal })).json() as { contentUrl: string; width: number; height: number };
    const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let response: Response;
    try { response = await fetch(thumbnail.contentUrl, { signal: imageSignal }); }
    catch {
      imageSignal.throwIfAborted();
      throw new SlidesError("Slide image download failed.", 502);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SlidesError(`Slide image download failed (HTTP ${response.status}).`, response.status);
    }
    const filename = `${crypto.randomUUID()}-slide-${slideNumber}.png`;
    const destination = path.join(folder, filename);
    const file = await open(destination, "wx", 0o600);
    created.push(destination);
    const reader = response.body?.getReader();
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    imageSignal.addEventListener("abort", cancel, { once: true });
    let bytes = 0;
    try {
      imageSignal.throwIfAborted();
      if (reader) for (;;) {
        const chunk = await reader.read();
        imageSignal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 10_000_000) throw new SlidesError("Slide image exceeds the 10 MB limit.", 413);
        await file.writeFile(chunk.value);
      }
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {});
      imageSignal.throwIfAborted();
      if (error instanceof SlidesError) throw error;
      throw new SlidesError("Slide image download failed.", 502);
    } finally {
      imageSignal.removeEventListener("abort", cancel);
      await file.close();
    }
    return { slideId: slide.objectId, slideNumber, path: path.join(files.runtimePath, filename), width: thumbnail.width, height: thumbnail.height };
  }
  const slides: Awaited<ReturnType<typeof render>>[] = new Array(selected.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(3, selected.length) }, async () => {
    try {
      while (next < selected.length) {
        signal.throwIfAborted();
        const index = next++;
        slides[index] = await render(selected[index]);
      }
    } catch (error) { failure.abort(error); throw error; }
  });
  const results = await Promise.allSettled(workers);
  const rejected = results.find(result => result.status === "rejected");
  if (rejected) {
    await Promise.all(created.map(destination => rm(destination, { force: true })));
    throw rejected.reason;
  }
  let contactSheet: { path: string; columns: number; slideIds: string[] } | null = null;
  let contactSheetError: string | undefined;
  if (slides.length > CONTACT_MAX_SLIDES) contactSheetError = `Contact sheets show at most ${CONTACT_MAX_SLIDES} slides. Render a smaller slideIds selection for a contact sheet.`;
  else if (slides.length > 1) {
    const filename = `${crypto.randomUUID()}-contact-sheet.png`;
    const destination = path.join(folder, filename);
    try {
      await writeContactSheet(slides.map(slide => path.join(folder, path.basename(slide.path))), destination);
      created.push(destination);
      contactSheet = { path: path.join(files.runtimePath, filename), columns: CONTACT_COLUMNS, slideIds: slides.map(slide => slide.slideId) };
    } catch (error) {
      await rm(destination, { force: true });
      contactSheetError = error instanceof Error ? error.message : String(error);
    }
  }
  return { presentationId, slides, contactSheet, ...(contactSheetError ? { contactSheetError } : {}) };
}
