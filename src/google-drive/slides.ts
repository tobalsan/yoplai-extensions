import type { z } from "zod";
import { createRequire } from "node:module";
const PptxGenJS: typeof import("pptxgenjs").default = createRequire(import.meta.url)("pptxgenjs");
import { imageSize } from "image-size";
import { readConversationFile, uploadDriveFile } from "./files.js";
import type { ToolExecutionContext } from "../tool-extension.js";
import type { DriveRequest } from "./files.js";
import type { SlidesCreateParamsSchema, SlidesGetParamsSchema, SlidesBatchUpdateParamsSchema } from "./slides-models.js";

const SLIDES = "https://slides.googleapis.com/v1/presentations";
export class SlidesError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface SlidePage { objectId: string; pageElements?: SlideElement[]; slideProperties?: { layoutObjectId?: string; notesPage?: { pageElements?: SlideElement[]; notesProperties?: { speakerNotesObjectId?: string } } }; }
export interface SlideElement {
  objectId: string; size?: unknown; transform?: unknown;
  shape?: { text?: SlideText }; table?: { tableRows?: { tableCells?: { text?: SlideText; [key: string]: unknown }[]; [key: string]: unknown }[]; [key: string]: unknown };
  elementGroup?: { children?: SlideElement[] }; [key: string]: unknown;
}
interface SlideText { textElements?: { textRun?: { content?: string; style?: unknown }; [key: string]: unknown }[]; [key: string]: unknown; }
export interface Presentation { presentationId: string; title?: string; pageSize?: { width?: { magnitude?: number; unit?: string }; height?: { magnitude?: number; unit?: string } }; slides?: SlidePage[]; revisionId?: string; masters?: { objectId: string; masterProperties?: { displayName?: string; name?: string } }[]; layouts?: { objectId: string; layoutProperties?: { displayName?: string; name?: string } }[]; }
function pageSize(deck: Presentation) { return { width: deck.pageSize?.width?.magnitude ?? 0, height: deck.pageSize?.height?.magnitude ?? 0, unit: deck.pageSize?.width?.unit ?? deck.pageSize?.height?.unit ?? "PT" }; }
export async function slidesCreate(params: z.infer<typeof SlidesCreateParamsSchema>, context: ToolExecutionContext | undefined, request: DriveRequest) {
  const signal = context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  let created: { id: string; webViewLink?: string };
  if (params.slides?.length) {
    if (params.slides.length > 50) throw new SlidesError("Local-image decks are limited to 50 slides.", 413);
    if (params.slides.reduce((count, slide) => count + slide.images.length, 0) > 30) throw new SlidesError("Local-image decks are limited to 30 images.", 413);
    const pptx = new PptxGenJS(); pptx.layout = "LAYOUT_16x9"; pptx.title = params.title;
    for (const input of params.slides) {
      const slide = pptx.addSlide();
      for (const image of input.images) {
        const { bytes, mimeType } = await readConversationFile(image.path, context, signal, 10_000_000);
        if (!["image/png", "image/jpeg", "image/gif"].includes(mimeType)) throw new SlidesError("Local images must be PNG, JPEG or GIF files.", 400);
        let dimensions: ReturnType<typeof imageSize>;
        try { dimensions = imageSize(bytes); } catch { throw new SlidesError("Invalid local PNG, JPEG or GIF image.", 400); }
        if (!["png", "jpg", "gif"].includes(dimensions.type ?? "") || dimensions.width <= 0 || dimensions.height <= 0) throw new SlidesError("Local images must contain valid PNG, JPEG or GIF bytes.", 400);
        const factor = Math.min(image.width / dimensions.width, image.height / dimensions.height);
        const width = dimensions.width * factor; const height = dimensions.height * factor;
        slide.addImage({ data: `data:${mimeType};base64,${bytes.toString("base64")}`, x: (image.x + (image.width - width) / 2) / 72, y: (image.y + (image.height - height) / 2) / 72, w: width / 72, h: height / 72 });
      }
    }
    const bytes = Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Uint8Array);
    if (bytes.byteLength > 50_000_000) throw new SlidesError("Generated PPTX exceeds the 50 MB PPTX limit.", 413);
    created = await uploadDriveFile({ name: params.title, mimeType: "application/vnd.google-apps.presentation", ...(params.parentId ? { parents: [params.parentId] } : {}) }, "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes, request, signal);
  } else {
    const response = await request("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ name: params.title, mimeType: "application/vnd.google-apps.presentation", ...(params.parentId ? { parents: [params.parentId] } : {}) }),
  });
    created = await response.json() as { id: string; webViewLink?: string };
  }
  const base = { presentationId: created.id, webViewLink: created.webViewLink ?? `https://docs.google.com/presentation/d/${created.id}/edit` };
  try {
    const deck = await (await request(`${SLIDES}/${encodeURIComponent(created.id)}`, { signal })).json() as Presentation;
    return { ...base, pageSize: pageSize(deck), slideIds: (deck.slides ?? []).map(slide => slide.objectId), revisionId: deck.revisionId ?? null };
  } catch (error) {
    return { ...base, pageSize: null, slideIds: [], revisionId: null, inspectionError: { message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}) } };
  }
}
export function resolvePresentationId(params: { presentationId?: string; presentationUrl?: string }): string {
  if (Boolean(params.presentationId) === Boolean(params.presentationUrl)) throw new SlidesError("Provide exactly one of presentationId or presentationUrl.", 400);
  if (params.presentationId) return params.presentationId;
  let url: URL;
  try { url = new URL(params.presentationUrl!); } catch { throw new SlidesError("Invalid presentationUrl.", 400); }
  const match = url.hostname === "docs.google.com" ? url.pathname.match(/^\/presentation\/d\/([^/]+)/)
    : url.hostname === "drive.google.com" ? url.pathname.match(/^\/file\/d\/([^/]+)/) : null;
  const id = match?.[1] ?? (url.hostname === "drive.google.com" && url.pathname === "/open" ? url.searchParams.get("id") : null);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new SlidesError("Invalid Google Slides or Drive presentationUrl.", 400);
  return id;
}
export function selectSlides(slides: SlidePage[], slideIds?: string[]) {
  for (const id of slideIds ?? []) if (!slides.some(slide => slide.objectId === id)) throw new SlidesError(`Unknown slide id: ${id}.`, 400);
  return slides.map((slide, index) => ({ slide, slideNumber: index + 1 })).filter(({ slide }) => !slideIds?.length || slideIds.includes(slide.objectId));
}
function textValue(text?: SlideText): string { return (text?.textElements ?? []).map(element => element.textRun?.content ?? "").join(""); }
function elementText(element: SlideElement): string {
  return [textValue(element.shape?.text), ...(element.table?.tableRows ?? []).flatMap(row => (row.tableCells ?? []).map(cell => textValue(cell.text))), ...(element.elementGroup?.children ?? []).map(elementText)].filter(Boolean).join(" ");
}
function clippedText(text: SlideText | undefined, budget: { remaining: number }) {
  const elements = (text?.textElements ?? []).map(element => {
    if (!element.textRun) return element;
    const content = (element.textRun.content ?? "").slice(0, budget.remaining);
    budget.remaining -= content.length;
    return { ...element, textRun: { ...element.textRun, content } };
  });
  return { ...text, textElements: elements };
}
function detail(element: SlideElement): Record<string, unknown> {
  const budget = { remaining: 2000 };
  const type = element.elementGroup ? "group" : ["shape", "table", "image", "line", "video", "sheetsChart", "wordArt"].find(key => element[key] !== undefined) ?? "unknown";
  const result: Record<string, unknown> = { id: element.objectId, type, ...(element.size ? { size: element.size } : {}), ...(element.transform ? { transform: element.transform } : {}) };
  if (element.shape) {
    const text = clippedText(element.shape.text, budget);
    Object.assign(result, { shape: { ...element.shape, text }, text: textValue(text), textElements: text.textElements });
  }
  if (element.table) result.table = { ...element.table, tableRows: (element.table.tableRows ?? []).map(row => ({ ...row, tableCells: (row.tableCells ?? []).map(cell => ({ ...cell, text: clippedText(cell.text, budget) })) })) };
  if (type === "group") result.children = (element.elementGroup?.children ?? []).map(detail);
  else if (type !== "shape" && type !== "table") result[type] = element[type];
  if (type !== "group" && elementText(element).length > 2000) result.textTruncated = true;
  return result;
}
function slideDetail(slide: SlidePage, slideNumber: number) {
  const notes = slide.slideProperties?.notesPage;
  const objectId = notes?.notesProperties?.speakerNotesObjectId ?? null;
  const note = notes?.pageElements?.find(element => element.objectId === objectId);
  return { slideId: slide.objectId, slideNumber, layoutId: slide.slideProperties?.layoutObjectId ?? null, elements: (slide.pageElements ?? []).map(detail), notes: { objectId, text: textValue(note?.shape?.text).slice(0, 2000), ...(textValue(note?.shape?.text).length > 2000 ? { textTruncated: true } : {}) } };
}
export async function slidesGet(params: z.infer<typeof SlidesGetParamsSchema>, request: DriveRequest, context?: ToolExecutionContext) {
  const id = resolvePresentationId(params);
  const deck = await (await request(`${SLIDES}/${encodeURIComponent(id)}`, { signal: context?.signal })).json() as Presentation;
  let selected = selectSlides(deck.slides ?? [], params.slideIds);
  if (params.startSlideId) {
    const start = selected.findIndex(({ slide }) => slide.objectId === params.startSlideId);
    if (start < 0) throw new SlidesError(`Unknown selected startSlideId: ${params.startSlideId}.`, 400);
    selected = selected.slice(start);
  }
  const result = { presentationId: id, title: deck.title ?? "", pageSize: pageSize(deck), revisionId: deck.revisionId ?? null,
    masters: (deck.masters ?? []).map(master => ({ id: master.objectId, name: master.masterProperties?.displayName ?? master.masterProperties?.name ?? "" })),
    layouts: (deck.layouts ?? []).map(layout => ({ id: layout.objectId, name: layout.layoutProperties?.displayName ?? layout.layoutProperties?.name ?? "" })),
    slides: [] as Record<string, unknown>[], truncated: false, nextSlideId: null as string | null,
  };
  const budget = params.slideIds?.length ? 60000 : 40000;
  if (JSON.stringify(result).length > budget) throw new SlidesError(`Deck metadata alone exceeds the ${budget} character budget.`, 413);
  for (let i = 0; i < selected.length; i++) {
    const { slide, slideNumber } = selected[i];
    const entry = params.slideIds?.length ? slideDetail(slide, slideNumber) : { slideId: slide.objectId, slideNumber, layoutId: slide.slideProperties?.layoutObjectId ?? null, text: (slide.pageElements ?? []).map(elementText).join(" ").slice(0, 300) };
    result.slides.push(entry);
    const next = selected[i + 1]?.slide.objectId ?? null;
    result.truncated = next !== null; result.nextSlideId = next;
    if (JSON.stringify(result).length > budget) {
      result.slides.pop(); result.truncated = true; result.nextSlideId = slide.objectId;
      if (!result.slides.length) throw new SlidesError(`Slide ${slide.objectId} exceeds the ${budget} character budget. Use the overview and slides_render for this slide.`, 413);
      return result;
    }
  }
  return result;
}
export async function slidesBatchUpdate(params: z.infer<typeof SlidesBatchUpdateParamsSchema>, request: DriveRequest, context?: ToolExecutionContext) {
  const id = resolvePresentationId(params);
  const result = await (await request(`${SLIDES}/${encodeURIComponent(id)}:batchUpdate`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: context?.signal, body: JSON.stringify({ requests: params.requests, ...(params.requiredRevisionId ? { writeControl: { requiredRevisionId: params.requiredRevisionId } } : {}) }) })).json() as { replies?: unknown[]; writeControl?: { requiredRevisionId?: string } };
  return { presentationId: id, replies: result.replies ?? [], revisionId: result.writeControl?.requiredRevisionId ?? null };
}
