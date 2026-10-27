import { z } from "zod";

const NullableString = z.string().nullable().optional();
const NullableNumber = z.number().nullable().optional();
const NullableBoolean = z.boolean().nullable().optional();
const NullableStringArray = z.array(z.string()).nullable().optional();

export const ZendeskConfigSchema = z.object({
  mode: z
    .enum(["api_key", "oauth"])
    .default("oauth")
    .describe(
      "Authentication mode (default oauth). api_key uses subdomain, email and API token; oauth connects a Zendesk account through the gateway's OAuth client (oauth.providers.zendesk).",
    ),
  subdomain: z
    .string()
    .regex(
      /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
      "Zendesk subdomain must be a single valid DNS label",
    )
    .optional()
    .describe("Zendesk subdomain, e.g. \"acme\" for acme.zendesk.com. Required in api_key mode."),
  email: z
    .string()
    .optional()
    .describe("Email address of the Zendesk account used to authenticate with the API token. Required in api_key mode."),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Zendesk API token for the account email. Generate one in Zendesk Admin Center under Apps and integrations > APIs > Zendesk API. Required in api_key mode.",
    ),
  timeoutMs: z
    .number()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for Zendesk API calls. Defaults to 30000."),
}).superRefine((config, ctx) => {
  if (config.mode !== "api_key") return;
  for (const field of ["subdomain", "email", "apiKey"] as const) {
    if (!config[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when mode is api_key`,
      });
    }
  }
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

export const SearchTicketsResultSchema = z.object({
  tickets: z.array(TicketSchema),
  count: z.number().optional(),
  nextPage: z.string().optional(),
});
export const GetTicketResultSchema = z.object({ ticket: TicketSchema });

/** Compact shapes (unknown keys stripped) so agent/group lists stay small in model context. */
export const GroupSchema = z.object({
  id: NullableNumber,
  name: NullableString,
  description: NullableString,
  default: NullableBoolean,
  deleted: NullableBoolean,
});
export type Group = z.infer<typeof GroupSchema>;

export const UserSchema = z.object({
  id: NullableNumber,
  name: NullableString,
  email: NullableString,
  role: NullableString,
  active: NullableBoolean,
  suspended: NullableBoolean,
  defaultGroupId: NullableNumber,
});
export type User = z.infer<typeof UserSchema>;

export const ListGroupsParamsSchema = z.object({
  pageSize: z.number().int().positive().max(100).optional().default(100),
  pageCursor: z.string().optional(),
});
export type ListGroupsParams = z.infer<typeof ListGroupsParamsSchema>;

export const ListAgentsParamsSchema = z.object({
  groupId: z.number().int().optional().describe("Only list members of this group."),
  pageSize: z.number().int().positive().max(100).optional().default(100),
  pageCursor: z.string().optional(),
});
export type ListAgentsParams = z.infer<typeof ListAgentsParamsSchema>;

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

const TicketIdSchema = z
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
  });

export const GetTicketParamsSchema = z.object({
  ticketId: TicketIdSchema,
});
export type GetTicketParams = z.infer<typeof GetTicketParamsSchema>;

/** Triage fields. "new" and "closed" cannot be set through the API, so they are excluded. */
export const UpdateTicketParamsSchema = z.object({
  ticketId: TicketIdSchema,
  status: z.enum(["open", "pending", "hold", "solved"]).optional(),
  priority: TicketPrioritySchema.optional(),
  type: TicketTypeSchema.optional(),
  assigneeId: z.number().int().optional().describe("Zendesk user id of the agent to assign."),
  groupId: z.number().int().optional().describe("Zendesk group id to route the ticket to."),
  addTags: z.array(z.string().min(1)).optional().describe("Tags to add; existing tags are kept."),
  removeTags: z.array(z.string().min(1)).optional().describe("Tags to remove."),
});
export type UpdateTicketParams = z.infer<typeof UpdateTicketParamsSchema>;

export const AddInternalNoteParamsSchema = z.object({
  ticketId: TicketIdSchema,
  body: z.string().min(1).describe("Note text. Visible to agents only, never to the requester."),
});
export type AddInternalNoteParams = z.infer<typeof AddInternalNoteParamsSchema>;

export const HelpCenterSectionSchema = z.object({
  id: z.number(),
  name: NullableString,
  sourceLocale: NullableString,
  categoryId: NullableNumber,
  categoryName: NullableString,
});

export const ListHelpCenterSectionsParamsSchema = z.object({
  categoryId: z.number().int().optional().describe("Only list sections in this category."),
  pageSize: z.number().int().positive().max(100).optional().default(100),
  pageCursor: z.string().optional(),
});
export const ListHelpCenterSectionsResultSchema = z.object({
  sections: z.array(HelpCenterSectionSchema),
  nextPageCursor: z.string().optional(),
  hasMore: z.boolean().optional(),
});

export const ArticleSchema = z.object({
  id: z.number(),
  title: NullableString,
  locale: NullableString,
  draft: NullableBoolean,
  sectionId: NullableNumber,
  htmlUrl: NullableString,
  permissionGroupId: NullableNumber,
  userSegmentId: NullableNumber,
  labelNames: NullableStringArray,
});
export type Article = z.infer<typeof ArticleSchema>;
export const ArticleResultSchema = z.object({ article: ArticleSchema });
export const ArticleAttachmentSchema = z.object({
  id: z.number(),
  contentUrl: z.string(),
  fileName: z.string(),
  size: z.number(),
});
export const UploadArticleAttachmentParamsSchema = z.object({
  articleId: z.number().int(),
  path: z.string().min(1).describe("Image filename or path inside the current conversation folder."),
  inline: z.boolean().default(true),
});
export const UploadArticleAttachmentResultSchema = z.object({
  attachment: ArticleAttachmentSchema,
  imgSnippet: z.string(),
});
export const ListArticlesParamsSchema = z.object({
  sectionId: z.number().int(),
  pageSize: z.number().int().positive().max(100).optional().default(100),
  pageCursor: z.string().optional(),
});
export const ListArticlesResultSchema = z.object({
  articles: z.array(ArticleSchema),
  nextPageCursor: z.string().optional(),
  hasMore: z.boolean().optional(),
});

export const CreateArticleParamsSchema = z.object({
  sectionId: z.number().int(),
  title: z.string().min(1),
  body: z.string().min(1).describe("Article body as HTML."),
  locale: z.string().min(1).describe("Use the section's source locale from zendesk_list_help_center_sections."),
  labelNames: z.array(z.string()).optional(),
  draft: z.boolean().optional().default(true),
  userSegmentId: z.number().int().optional().describe("Copy this id from an article in the same section (`zendesk_list_articles`). Do not guess it. Omit for public visibility."),
  permissionGroupId: z.number().int().optional().describe("Copy this id from an article in the same section (`zendesk_list_articles`). Do not guess it. Always pass it: otherwise Zendesk uses the Admins group and the call can fail for non-admins."),
  notifySubscribers: z.boolean().optional().describe("Set false to avoid notifying subscribers."),
});

export const UpdateArticleParamsSchema = z.object({
  articleId: z.number().int(),
  locale: z.string().min(1),
  title: z.string().min(1).optional(),
  body: z.string().optional().describe("Replacement article body as HTML."),
  draft: z.boolean().optional(),
  labelNames: z.array(z.string()).optional(),
});

export const ArchiveArticleParamsSchema = z.object({
  articleId: z.number().int(),
});
export const ArchiveArticleResultSchema = z.object({
  archived: z.literal(true),
  articleId: z.number().int(),
  title: NullableString,
});
