import { z } from "zod";

const reference = { presentationId: z.string().min(1).optional(), presentationUrl: z.string().min(1).optional() };
export const SlidesCreateParamsSchema = z.object({ title: z.string().min(1), parentId: z.string().min(1).optional(), slides: z.array(z.object({ images: z.array(z.object({ path: z.string().min(1), x: z.number().finite(), y: z.number().finite(), width: z.number().positive().finite(), height: z.number().positive().finite() })) })).optional() });
const pageSize = z.object({ width: z.number(), height: z.number(), unit: z.string() });
export const SlidesCreateResultSchema = z.object({ presentationId: z.string(), webViewLink: z.string(), pageSize: pageSize.nullable(), slideIds: z.array(z.string()), revisionId: z.string().nullable(), inspectionError: z.object({ message: z.string(), status: z.number().optional() }).optional() });
export const SlidesGetParamsSchema = z.object({ ...reference, slideIds: z.array(z.string()).optional(), startSlideId: z.string().optional() });
export const SlidesGetResultSchema = z.object({ presentationId: z.string(), title: z.string(), pageSize: pageSize, revisionId: z.string().nullable(), masters: z.array(z.object({ id: z.string(), name: z.string() })), layouts: z.array(z.object({ id: z.string(), name: z.string() })), slides: z.array(z.record(z.unknown())), truncated: z.boolean(), nextSlideId: z.string().nullable() });
export const SlidesBatchUpdateParamsSchema = z.object({ ...reference, requests: z.array(z.record(z.unknown())).min(1), requiredRevisionId: z.string().optional() });
export const SlidesBatchUpdateResultSchema = z.object({ presentationId: z.string(), replies: z.array(z.unknown()), revisionId: z.string().nullable() });
