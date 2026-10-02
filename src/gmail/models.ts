import { z } from "zod";

export const GmailConfigSchema = z.object({}).passthrough();

const PageSchema = z.object({
  pageSize: z.number().int().min(1).max(50).optional().default(20),
  pageToken: z.string().min(1).optional(),
});

export const CreateDraftParamsSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().refine((value) => !/[\r\n]/.test(value), "Subject must not contain line breaks.").optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyToMessageId: z.string().min(1).optional(),
}).strict();
export const UpdateDraftParamsSchema = CreateDraftParamsSchema.omit({ replyToMessageId: true }).partial().extend({ draftId: z.string().min(1) }).strict();
export const DeleteDraftParamsSchema = z.object({ draftId: z.string().min(1) }).strict();
export const ListDraftsParamsSchema = PageSchema.extend({ query: z.string().optional() }).strict();
export const GetThreadParamsSchema = z.object({
  threadId: z.string().min(1),
  messageFormat: z.enum(["MINIMAL", "FULL_CONTENT"]).optional(),
}).strict();
export const SearchThreadsParamsSchema = PageSchema.extend({
  query: z.string().optional(),
  includeTrash: z.boolean().optional(),
}).strict();
const LabelMutationSchema = z.object({ labelIds: z.array(z.string().min(1)).min(1) });
export const LabelThreadParamsSchema = LabelMutationSchema.extend({ threadId: z.string().min(1) }).strict();
export const LabelMessageParamsSchema = LabelMutationSchema.extend({ messageId: z.string().min(1) }).strict();
export const ListLabelsParamsSchema = PageSchema.strict();
export const CreateLabelParamsSchema = z.object({
  displayName: z.string().min(1),
  color: z.object({ textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
}).strict();

export type CreateDraftParams = z.infer<typeof CreateDraftParamsSchema>;
export type UpdateDraftParams = z.infer<typeof UpdateDraftParamsSchema>;
export type ListDraftsParams = z.infer<typeof ListDraftsParamsSchema>;
export type GetThreadParams = z.infer<typeof GetThreadParamsSchema>;
export type SearchThreadsParams = z.infer<typeof SearchThreadsParamsSchema>;
export type LabelThreadParams = z.infer<typeof LabelThreadParamsSchema>;
export type LabelMessageParams = z.infer<typeof LabelMessageParamsSchema>;
export type CreateLabelParams = z.infer<typeof CreateLabelParamsSchema>;

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
