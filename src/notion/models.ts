import { z } from "zod";

const StringInput = z.string();
const OptionalString = z.string().optional();
const JsonObject = z.record(z.unknown());
const JsonArray = z.array(z.unknown());

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

const OptionalNumber = z
  .union([z.number().int().positive(), PositiveIntegerString])
  .optional();

const JsonObjectString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON object",
      });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON object string",
    });
    return z.NEVER;
  }
});

const JsonArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON array",
      });
      return z.NEVER;
    }
    return parsed;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON array string",
    });
    return z.NEVER;
  }
});

const JsonObjectInput = z.union([JsonObject, JsonObjectString]);
const JsonArrayInput = z.union([JsonArray, JsonArrayString]);
const HeadingTypeSchema = z.enum(["heading_1", "heading_2", "heading_3"]);
const StringArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === "string" && item.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON string array",
      });
      return z.NEVER;
    }
    return parsed as string[];
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON string array",
    });
    return z.NEVER;
  }
});
const HeadingTypeArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    const allowed = new Set(["heading_1", "heading_2", "heading_3"]);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === "string" && allowed.has(item))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON heading type array",
      });
      return z.NEVER;
    }
    return parsed as Array<z.infer<typeof HeadingTypeSchema>>;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON heading type array",
    });
    return z.NEVER;
  }
});
const StringArrayInput = z.union([
  z.array(z.string().min(1)).min(1),
  StringArrayString,
]);
const HeadingTypeArrayInput = z.union([
  z.array(HeadingTypeSchema).min(1),
  HeadingTypeArrayString,
]);

export const NotionConfigSchema = z.object({
  apiKey: z.string().describe(
    "Notion integration secret from an internal integration at notion.so/my-integrations. Starts with `ntn_` or `secret_`.",
  ),
  notionVersion: z
    .string()
    .optional()
    .default("2026-03-11")
    .describe("Notion API version header (YYYY-MM-DD). Defaults to 2026-03-11; only change if instructed by Notion."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for calls to the Notion API. Defaults to 30000."),
});

export const ListDataSourcesParamsSchema = z
  .object({
    query: z.string().optional().describe("Title text to filter results; omit to list all shared data sources."),
    pageSize: OptionalNumber.describe("Max results per page (Notion default/max ~100)."),
    startCursor: OptionalString.describe("Cursor from a previous response's next_cursor to fetch the next page."),
  })
  .strict();

export const ListPagesParamsSchema = z
  .object({
    query: z.string().optional().describe("Title text to filter results; omit to list all shared pages."),
    pageSize: OptionalNumber.describe("Max results per page (Notion default/max ~100)."),
    startCursor: OptionalString.describe("Cursor from a previous response's next_cursor to fetch the next page."),
  })
  .strict();

export const SearchPagesParamsSchema = z
  .object({
    query: z.string().min(1).describe("Required title text to match; this matches page titles only, not body content."),
    pageSize: OptionalNumber.describe("Max results per page (Notion default/max ~100)."),
    startCursor: OptionalString.describe("Cursor from a previous response's next_cursor to fetch the next page."),
  })
  .strict();

export const GetDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput.describe("ID of the data source (Notion database) to fetch."),
  })
  .strict();

export const UpdateDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput.describe("ID of the data source to update."),
    title: z.union([z.string(), JsonArray]).optional().describe("New title as plain text or a Notion rich-text array."),
    description: z.union([z.string(), JsonArray]).optional().describe("New description as plain text or a Notion rich-text array."),
    properties: JsonObjectInput.optional().describe("Property schema definitions to add or modify, keyed by property name."),
  })
  .strict();

export const QueryDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput,
    filter: JsonObjectInput.optional().describe(
      "Optional Notion filter. Omit to return the ENTIRE data source. Only set this if the user explicitly asked to narrow results — an unrequested filter silently drops rows and breaks completeness.",
    ),
    sorts: JsonArrayInput.optional(),
    pageSize: OptionalNumber.describe(
      "Rows per network page (max 100) used for internal auto-pagination. Does NOT limit the dataset — all pages are fetched and merged regardless.",
    ),
    startCursor: OptionalString.describe(
      "Optional Notion cursor to begin auto-pagination from. Usually omit; the tool fetches every page until exhausted.",
    ),
  })
  .strict();

export const GetPageParamsSchema = z
  .object({
    pageId: StringInput.describe("ID of the page to fetch."),
  })
  .strict();

export const GetPageMarkdownParamsSchema = z
  .object({
    pageId: StringInput.describe("ID of the page to fetch content for."),
    includeTranscript: z.boolean().optional().describe(
      "Include meeting note transcripts in the markdown. Defaults to false.",
    ),
  })
  .strict();

export const CreatePageParamsSchema = z
  .object({
    dataSourceId: OptionalString.describe(
      "Data source to add a new row to. Exactly one of dataSourceId or pageId is required.",
    ),
    pageId: OptionalString.describe(
      "Parent page to create a subpage under. Exactly one of dataSourceId or pageId is required.",
    ),
    properties: JsonObjectInput.optional().describe(
      "Property values keyed by property name. For a data source parent, keys must match the data source's properties; for a page parent, only `title` is valid.",
    ),
    children: JsonArrayInput.optional(),
    markdown: OptionalString.describe(
      "Page content as Notion-flavored Markdown. Mutually exclusive with children. If no title is given, the first `# h1` heading becomes the page title.",
    ),
    icon: JsonObjectInput.optional().describe("Page icon, e.g. { emoji: \"📄\" } or an external file object."),
    cover: JsonObjectInput.optional().describe("Page cover image as an external file object."),
  })
  .strict();

export const UpdatePagePropertiesParamsSchema = z
  .object({
    pageId: StringInput.describe("ID of the page whose property values will be updated."),
    properties: JsonObjectInput.describe(
      "Property values to set, keyed by property name or ID. Updates property values only — never page content/body.",
    ),
  })
  .strict();

const ContentUpdateItemSchema = z.object({
  oldStr: z.string().min(1),
  newStr: z.string(),
  replaceAllMatches: z.boolean().optional(),
});

const ContentUpdatesArrayString = z.string().transform((value, ctx) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    const result = z.array(ContentUpdateItemSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected JSON array of content updates",
      });
      return z.NEVER;
    }
    return result.data;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON content updates array",
    });
    return z.NEVER;
  }
});

const ContentUpdatesInput = z.union([z.array(ContentUpdateItemSchema), ContentUpdatesArrayString]);

export const UpdatePageMarkdownParamsSchema = z
  .object({
    pageId: StringInput.describe("ID of the page whose content will be edited."),
    mode: z
      .enum(["update_content", "replace_content"])
      .describe("update_content for targeted find/replace; replace_content to overwrite all page content."),
    contentUpdates: ContentUpdatesInput.optional().describe(
      "Required for mode update_content. Array (max 100) of { oldStr, newStr, replaceAllMatches? } find/replace operations.",
    ),
    newStr: OptionalString.describe(
      "Required for mode replace_content. Full Notion-flavored Markdown replacing all existing page content.",
    ),
    allowDeletingContent: z.boolean().optional().describe(
      "Allow operations that delete existing content. Defaults to false.",
    ),
  })
  .strict();

export const GetBlocksParamsSchema = z
  .object({
    blockId: StringInput.describe("ID of the page or block whose direct children to fetch."),
    pageSize: OptionalNumber.describe("Max results per page (Notion default/max ~100)."),
    startCursor: OptionalString.describe("Cursor from a previous response's next_cursor to fetch the next page."),
  })
  .strict();

export const AppendBlocksParamsSchema = z
  .object({
    blockId: StringInput.describe("ID of the page or block to append children to."),
    children: JsonArrayInput.describe("Array of raw Notion block objects to append."),
  })
  .strict();

export const DeleteBlockParamsSchema = z
  .object({
    blockId: StringInput.describe("ID of the block to delete/archive. Get this from get_blocks."),
  })
  .strict();

export const ReplaceChildBlocksParamsSchema = z
  .object({
    blockId: StringInput.describe("ID of the parent page or block whose direct children are scanned for matching headings."),
    headingTexts: StringArrayInput.describe(
      "Heading text(s) to match (case-insensitive, trimmed). Each match and its following non-heading siblings are deleted after the new blocks are appended.",
    ),
    headingTypes: HeadingTypeArrayInput.optional().describe(
      "Restrict matching to these heading levels only. Omit to match heading_1/heading_2/heading_3 blocks with matching text.",
    ),
    children: JsonArrayInput.describe("Raw Notion blocks to append before deleting the matched sections."),
    pageSize: OptionalNumber.describe("Page size used when internally fetching all children to scan for headings."),
  })
  .strict();

export const DownloadAndExtractFileParamsSchema = z
  .object({
    url: StringInput.describe("URL of the file to download, e.g. a Notion file/attachment URL."),
    filename: z.string().optional().describe("Filename hint used to detect PDF/DOCX when the URL/content-type is ambiguous."),
    contentType: z.string().optional().describe("Content-type hint used to detect PDF/DOCX when the URL/filename is ambiguous."),
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
