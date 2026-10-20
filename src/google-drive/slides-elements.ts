import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ToolExecutionContext } from "../tool-extension.js";
import type { DriveRequest } from "./files.js";
import { renderAfterWrite, resolvePresentationId, sendBatchUpdate, SlidesError, type RenderAfterWrite } from "./slides.js";
import type { SlideElementInput, SlidesAddElementsParamsSchema } from "./slides-models.js";

const SHAPE_TYPES = { text: "TEXT_BOX", rect: "RECTANGLE", roundRect: "ROUND_RECTANGLE", ellipse: "ELLIPSE" } as const;
const ALIGNMENTS = { left: "START", center: "CENTER", right: "END", justify: "JUSTIFIED" } as const;
const CONTENT_ALIGNMENTS = { top: "TOP", middle: "MIDDLE", bottom: "BOTTOM" } as const;
const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
function rgb(hex: string) { return { rgbColor: { red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 } }; }
const newId = () => `el_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

/** Builds Slides API requests for point-based elements on an existing slide; ids follow element order. */
export function buildElementRequests(slideId: string, elements: SlideElementInput[]) {
  if (elements.some(element => element.radius !== undefined)) throw new SlidesError("Google Slides API cannot set corner radius; create the deck with slides_create elements to control radius.", 400);
  if (elements.some(element => element.path)) throw new SlidesError("Local images need slides_create (path); slides_add_elements accepts public image url only.", 400);
  const requests: Record<string, unknown>[] = [];
  const elementIds: string[] = [];
  for (const element of elements) {
    const objectId = element.id ?? newId();
    elementIds.push(objectId);
    const elementProperties = { pageObjectId: slideId, size: { width: pt(element.w), height: pt(element.h) }, transform: { scaleX: 1, scaleY: 1, translateX: element.x, translateY: element.y, unit: "PT" } };
    if (element.kind === "image") { requests.push({ createImage: { objectId, url: element.url, elementProperties } }); continue; }
    if (element.kind === "line") {
      requests.push({ createLine: { objectId, lineCategory: "STRAIGHT", elementProperties } });
      const color = element.outline?.color ?? element.color; const weight = element.outline?.weight;
      if (color || weight) requests.push({ updateLineProperties: { objectId, lineProperties: { ...(color ? { lineFill: { solidFill: { color: rgb(color) } } } : {}), ...(weight ? { weight: pt(weight) } : {}) }, fields: [color ? "lineFill.solidFill.color" : "", weight ? "weight" : ""].filter(Boolean).join(",") } });
      continue;
    }
    requests.push({ createShape: { objectId, shapeType: SHAPE_TYPES[element.kind], elementProperties } });
    const shape: Record<string, unknown> = {}; const fields: string[] = [];
    if (element.fill) { shape.shapeBackgroundFill = { solidFill: { color: rgb(element.fill) } }; fields.push("shapeBackgroundFill.solidFill.color"); }
    if (element.outline) {
      shape.outline = { outlineFill: { solidFill: { color: rgb(element.outline.color) } }, ...(element.outline.weight ? { weight: pt(element.outline.weight) } : {}) };
      fields.push("outline.outlineFill.solidFill.color", ...(element.outline.weight ? ["outline.weight"] : []));
    } else if (element.kind !== "text") { shape.outline = { propertyState: "NOT_RENDERED" }; fields.push("outline.propertyState"); }
    if (element.valign) { shape.contentAlignment = CONTENT_ALIGNMENTS[element.valign]; fields.push("contentAlignment"); }
    if (fields.length) requests.push({ updateShapeProperties: { objectId, shapeProperties: shape, fields: fields.join(",") } });
    if (!element.text) continue;
    requests.push({ insertText: { objectId, text: element.text, insertionIndex: 0 } });
    const style: Record<string, unknown> = {}; const styleFields: string[] = [];
    if (element.font) { style.fontFamily = element.font; styleFields.push("fontFamily"); }
    if (element.size) { style.fontSize = pt(element.size); styleFields.push("fontSize"); }
    if (element.bold !== undefined) { style.bold = element.bold; styleFields.push("bold"); }
    if (element.italic !== undefined) { style.italic = element.italic; styleFields.push("italic"); }
    if (element.color) { style.foregroundColor = { opaqueColor: rgb(element.color) }; styleFields.push("foregroundColor"); }
    if (styleFields.length) requests.push({ updateTextStyle: { objectId, textRange: { type: "ALL" }, style, fields: styleFields.join(",") } });
    const paragraph: Record<string, unknown> = {}; const paragraphFields: string[] = [];
    if (element.align) { paragraph.alignment = ALIGNMENTS[element.align]; paragraphFields.push("alignment"); }
    if (element.lineSpacing) { paragraph.lineSpacing = element.lineSpacing; paragraphFields.push("lineSpacing"); }
    if (paragraphFields.length) requests.push({ updateParagraphStyle: { objectId, textRange: { type: "ALL" }, style: paragraph, fields: paragraphFields.join(",") } });
  }
  return { requests, elementIds };
}

export async function slidesAddElements(params: z.infer<typeof SlidesAddElementsParamsSchema>, request: DriveRequest, context?: ToolExecutionContext, render?: RenderAfterWrite) {
  const id = resolvePresentationId(params);
  if (params.slideId && params.newSlide) throw new SlidesError("Provide at most one of slideId or newSlide.", 400);
  const slideId = params.slideId ?? newId().replace("el_", "slide_");
  const { requests, elementIds } = buildElementRequests(slideId, params.elements);
  if (!params.slideId) requests.unshift({ createSlide: { objectId: slideId, ...(params.newSlide?.insertionIndex !== undefined ? { insertionIndex: params.newSlide.insertionIndex } : {}), slideLayoutReference: { predefinedLayout: "BLANK" } } });
  const { revisionId } = await sendBatchUpdate(id, requests, params.requiredRevisionId, request, context);
  const result = { presentationId: id, slideId, elementIds, revisionId };
  return params.render && render ? { ...result, ...await renderAfterWrite(render, [slideId]) } : result;
}
