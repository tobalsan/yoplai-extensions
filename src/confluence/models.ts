import { z } from "zod";

const StringInput = z.string().min(1);
const OptionalString = z.string().optional();

const PositiveIntegerString = z.string().transform((value, ctx) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected positive integer",
    });
    return z.NEVER;
  }
  return parsed;
});

const NonNegativeIntegerString = z.string().transform((value, ctx) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected non-negative integer",
    });
    return z.NEVER;
  }
  return parsed;
});

const OptionalPositiveInteger = z
  .union([z.number().int().positive(), PositiveIntegerString])
  .optional();

const OptionalNonNegativeInteger = z
  .union([z.number().int().nonnegative(), NonNegativeIntegerString])
  .optional();

const BodyFormatSchema = z.enum([
  "storage",
  "atlas_doc_format",
  "view",
  "anonymous_export_view",
]);

export const ConfluenceConfigSchema = z.object({
  subdomain: z.string().min(1),
  email: z.string().email(),
  apiToken: z.string().min(1),
  confluenceSpace: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional().default(30_000),
});

export const SearchParamsSchema = z
  .object({
    cql: StringInput,
    limit: OptionalPositiveInteger,
    start: OptionalNonNegativeInteger,
    expand: OptionalString,
  })
  .strict();

export const GetPageParamsSchema = z
  .object({
    pageId: StringInput.describe(
      "Numeric id of a real Confluence wiki page. Do NOT pass a space id or the id of non-page content (whiteboard, database, folder, smart link) — those return an opaque 500. Find page ids via confluence_search or confluence_list_space_pages.",
    ),
    bodyFormat: BodyFormatSchema.optional(),
  })
  .strict();

export const GetPageChildrenParamsSchema = z
  .object({
    pageId: StringInput.describe(
      "Numeric id of a real Confluence wiki page (not a space id or non-page content, which return an opaque 500).",
    ),
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const GetPageAncestorsParamsSchema = z
  .object({
    pageId: StringInput.describe(
      "Numeric id of a real Confluence wiki page (not a space id or non-page content, which return an opaque 500).",
    ),
    limit: OptionalPositiveInteger,
  })
  .strict();

export const ListAttachmentsParamsSchema = z
  .object({
    pageId: StringInput,
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const DownloadAndExtractFileParamsSchema = z
  .object({
    url: StringInput,
    filename: z.string().optional(),
    contentType: z.string().optional(),
  })
  .strict();

export const ListLabelsParamsSchema = z
  .object({
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const GetPagesByLabelParamsSchema = z
  .object({
    labelId: StringInput,
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const ListSpacePagesParamsSchema = z
  .object({
    spaceId: OptionalString.describe(
      "Numeric space id (e.g. \"54362117\"), NOT the space key like \"CS\" — a key here causes an opaque 500. Resolve a key to its numeric id with confluence_list_spaces. Optional only when confluenceSpace is configured.",
    ),
    depth: z.enum(["all", "root"]).optional(),
    sort: z
      .enum([
        "id",
        "-id",
        "created-date",
        "-created-date",
        "modified-date",
        "-modified-date",
        "title",
        "-title",
      ])
      .optional(),
    status: z.array(z.enum(["current", "archived", "deleted", "trashed"])).optional(),
    bodyFormat: BodyFormatSchema.optional(),
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const ListSpacesParamsSchema = z
  .object({
    keys: OptionalString,
    type: z.enum(["global", "collaboration", "knowledge_base", "personal"]).optional(),
    status: z.enum(["current", "archived"]).optional(),
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const CreatePageParamsSchema = z
  .object({
    spaceId: OptionalString,
    parentId: OptionalString,
    title: StringInput,
    body: StringInput,
  })
  .strict();

export const ReplacePageParamsSchema = z
  .object({
    pageId: StringInput,
    title: OptionalString,
    body: StringInput,
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceBodyFormat = z.infer<typeof BodyFormatSchema>;
