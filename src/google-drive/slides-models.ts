import { z } from "zod";

const reference = { presentationId: z.string().min(1).optional(), presentationUrl: z.string().min(1).optional() };
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "Use a #RRGGBB hex color.").transform(value => value.replace("#", "").toUpperCase());
const point = z.number().finite();
const SlideElementObjectSchema = z.object({
  kind: z.enum(["text", "rect", "roundRect", "ellipse", "line", "image"]),
  id: z.string().min(5).max(50).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_:-]*$/, "Use 5-50 characters: letters, digits, _, - or :, and do not start with - or :.").optional(),
  x: point, y: point, w: point.min(0), h: point.min(0),
  text: z.string().optional(), font: z.string().min(1).optional(), size: z.number().positive().finite().optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), color: hex.optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(), valign: z.enum(["top", "middle", "bottom"]).optional(), lineSpacing: z.number().positive().finite().optional(),
  fill: hex.optional(), outline: z.object({ color: hex, weight: z.number().positive().finite().optional() }).optional(), radius: z.number().min(0).finite().optional(),
  url: z.string().url().optional(), path: z.string().min(1).optional(),
});
function checkElement(element: z.infer<typeof SlideElementObjectSchema>, ctx: z.RefinementCtx) {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (element.kind !== "line" && (element.w <= 0 || element.h <= 0)) issue("w and h must be greater than 0.");
  if (element.kind === "image" && !element.url && !element.path) issue("image elements need url or path.");
  if (element.kind === "image" && element.url && element.path) issue("image elements take url or path, not both.");
  if (element.kind !== "image" && (element.url || element.path)) issue("url and path are only for image elements.");
  if (element.radius !== undefined && element.kind !== "roundRect") issue("radius is only for roundRect elements.");
  if (element.text !== undefined && (element.kind === "line" || element.kind === "image")) issue("text is not allowed on line or image elements.");
}
export const SlideElementSchema = SlideElementObjectSchema.superRefine(checkElement);
// Google assigns new ids on PPTX import, so slides_create accepts any element id and ignores it.
const CreateElementSchema = SlideElementObjectSchema.extend({ id: z.string().optional() }).superRefine(checkElement);
export type SlideElementInput = z.infer<typeof SlideElementSchema>;
const SlideInputSchema = z.object({ images: z.array(z.object({ path: z.string().min(1), x: z.number().finite(), y: z.number().finite(), width: z.number().positive().finite(), height: z.number().positive().finite() })).default([]), elements: z.array(CreateElementSchema).optional(), background: hex.optional(), notes: z.string().optional() });
export const SlidesCreateParamsSchema = z.object({ title: z.string().min(1), parentId: z.string().min(1).optional(), slides: z.array(SlideInputSchema).optional() });
const pageSize = z.object({ width: z.number(), height: z.number(), unit: z.string() });
export const SlidesCreateResultSchema = z.object({ presentationId: z.string(), webViewLink: z.string(), pageSize: pageSize.nullable(), slideIds: z.array(z.string()), revisionId: z.string().nullable(), slides: z.array(z.object({ slideId: z.string(), elementIds: z.array(z.string()) })), inspectionError: z.object({ message: z.string(), status: z.number().optional() }).optional() });
export const SlidesGetParamsSchema = z.object({ ...reference, slideIds: z.array(z.string()).optional(), startSlideId: z.string().optional() });
export const SlidesGetResultSchema = z.object({ presentationId: z.string(), title: z.string(), pageSize: pageSize, revisionId: z.string().nullable(), masters: z.array(z.object({ id: z.string(), name: z.string() })), layouts: z.array(z.object({ id: z.string(), name: z.string() })), slides: z.array(z.record(z.unknown())), truncated: z.boolean(), nextSlideId: z.string().nullable() });
const renderError = z.object({ message: z.string() });
export const SlidesRenderResultSchema = z.object({ presentationId: z.string(), slides: z.array(z.object({ slideId: z.string(), slideNumber: z.number(), path: z.string(), width: z.number(), height: z.number() })), contactSheet: z.object({ path: z.string(), columns: z.number(), slideIds: z.array(z.string()) }).nullable(), contactSheetError: z.string().optional() });
export const SlidesBatchUpdateParamsSchema = z.object({ ...reference, requests: z.array(z.record(z.unknown())).min(1).optional(), requestsPath: z.string().min(1).optional(), requiredRevisionId: z.string().optional(), renderSlideIds: z.array(z.string().min(1)).optional() });
export const SlidesBatchUpdateResultSchema = z.object({ presentationId: z.string(), replies: z.array(z.unknown()), revisionId: z.string().nullable(), render: SlidesRenderResultSchema.optional(), renderError: renderError.optional() });
export const SlidesAddElementsParamsSchema = z.object({ ...reference, slideId: z.string().min(1).optional(), newSlide: z.object({ insertionIndex: z.number().int().min(0).optional() }).optional(), elements: z.array(SlideElementSchema).min(1).max(100), requiredRevisionId: z.string().optional(), render: z.boolean().optional() });
export const SlidesAddElementsResultSchema = z.object({ presentationId: z.string(), slideId: z.string(), elementIds: z.array(z.string()), revisionId: z.string().nullable(), render: SlidesRenderResultSchema.optional(), renderError: renderError.optional() });
