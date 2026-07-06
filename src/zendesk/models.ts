import { z } from "zod";

const NullableString = z.string().nullable().optional();
const NullableNumber = z.number().nullable().optional();
const NullableBoolean = z.boolean().nullable().optional();
const NullableStringArray = z.array(z.string()).nullable().optional();

export const ZendeskConfigSchema = z.object({
  subdomain: z.string().describe("Zendesk subdomain, e.g. \"acme\" for acme.zendesk.com."),
  email: z
    .string()
    .describe("Email address of the Zendesk account used to authenticate with the API token."),
  apiKey: z
    .string()
    .describe(
      "Zendesk API token for the account email. Generate one in Zendesk Admin Center under Apps and integrations > APIs > Zendesk API.",
    ),
  timeoutMs: z
    .number()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for Zendesk API calls. Defaults to 30000."),
});
export type ZendeskConfig = z.infer<typeof ZendeskConfigSchema>;

export const TicketStatusSchema = z.enum(["new", "open", "pending", "hold", "solved", "closed"]);
export const TicketPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const TicketTypeSchema = z.enum(["problem", "incident", "question", "task"]);

export const AttachmentSchema = z
  .object({
    id: NullableNumber,
    fileName: NullableString,
    contentUrl: NullableString,
    contentType: NullableString,
    size: NullableNumber,
  })
  .passthrough();
export type Attachment = z.infer<typeof AttachmentSchema>;

export const CommentSchema = z
  .object({
    id: NullableNumber,
    body: NullableString,
    htmlBody: NullableString,
    authorId: NullableNumber,
    public: NullableBoolean,
    createdAt: NullableString,
    attachments: z.array(AttachmentSchema).nullable().optional(),
  })
  .passthrough();
export type Comment = z.infer<typeof CommentSchema>;

export const TicketSchema = z
  .object({
    id: NullableNumber,
    url: NullableString,
    subject: NullableString,
    description: NullableString,
    status: TicketStatusSchema.nullable().optional(),
    priority: TicketPrioritySchema.nullable().optional(),
    type: TicketTypeSchema.nullable().optional(),
    requesterId: NullableNumber,
    requesterEmail: NullableString,
    submitterId: NullableNumber,
    assigneeId: NullableNumber,
    groupId: NullableNumber,
    organizationId: NullableNumber,
    tags: NullableStringArray,
    externalId: NullableString,
    createdAt: NullableString,
    updatedAt: NullableString,
    dueAt: NullableString,
    comments: z.array(CommentSchema).nullable().optional(),
  })
  .passthrough();
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsParamsSchema = z.object({
  pageSize: z.number().int().positive().max(100).optional().default(20),
  pageCursor: z.string().optional(),
  sort: z
    .enum(["id", "-id", "updated_at", "-updated_at", "status", "-status"])
    .optional()
    .default("-id"),
});
export type ListTicketsParams = z.infer<typeof ListTicketsParamsSchema>;

export const SearchTicketsParamsSchema = z.object({
  query: z.string().min(1),
  pageSize: z.number().int().positive().max(100).optional().default(100),
  page: z.number().int().positive().optional().default(1),
  sortBy: z.enum(["created_at", "updated_at", "priority", "status", "ticket_type"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});
export type SearchTicketsParams = z.infer<typeof SearchTicketsParamsSchema>;

export const GetTicketParamsSchema = z.object({
  ticketId: z
    .union([z.number().int(), z.string()])
    .transform((value, ctx) => {
      const parsed = typeof value === "string" ? Number(value) : value;
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.invalid_type,
          expected: "integer",
          received: typeof value === "string" ? "string" : "number",
        });
        return z.NEVER;
      }
      return parsed;
    }),
});
export type GetTicketParams = z.infer<typeof GetTicketParamsSchema>;
