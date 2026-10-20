import { open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext } from "../tool-extension.js";
import type { DriveRequest } from "./files.js";
import { resolvePresentationId, selectSlides, SlidesError, type Presentation, type SlidePage } from "./slides.js";

export interface SlidesRenderParams { presentationId?: string; presentationUrl?: string; slideIds?: string[] }

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
  return { presentationId, slides };
}
