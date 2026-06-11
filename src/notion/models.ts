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
  apiKey: z.string(),
  notionVersion: z.string().optional().default("2026-03-11"),
  timeoutMs: z.number().int().positive().optional().default(30_000),
  largeResultDir: z.string().optional(),
});

export const ListDataSourcesParamsSchema = z
  .object({
    query: z.string().optional(),
    pageSize: OptionalNumber,
    startCursor: OptionalString,
  })
  .strict();

export const ListPagesParamsSchema = z
  .object({
    query: z.string().optional(),
    pageSize: OptionalNumber,
    startCursor: OptionalString,
  })
  .strict();

export const SearchPagesParamsSchema = z
  .object({
    query: z.string().min(1),
    pageSize: OptionalNumber,
    startCursor: OptionalString,
  })
  .strict();

export const GetDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput,
  })
  .strict();

export const UpdateDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput,
    title: z.union([z.string(), JsonArray]).optional(),
    description: z.union([z.string(), JsonArray]).optional(),
    properties: JsonObjectInput.optional(),
  })
  .strict();

export const QueryDataSourceParamsSchema = z
  .object({
    dataSourceId: StringInput,
    filter: JsonObjectInput.optional(),
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
    pageId: StringInput,
  })
  .strict();

export const UpdatePagePropertiesParamsSchema = z
  .object({
    pageId: StringInput,
    properties: JsonObjectInput,
  })
  .strict();

export const GetBlocksParamsSchema = z
  .object({
    blockId: StringInput,
    pageSize: OptionalNumber,
    startCursor: OptionalString,
  })
  .strict();

export const AppendBlocksParamsSchema = z
  .object({
    blockId: StringInput,
    children: JsonArrayInput,
  })
  .strict();

export const DeleteBlockParamsSchema = z
  .object({
    blockId: StringInput,
  })
  .strict();

export const ReplaceChildBlocksParamsSchema = z
  .object({
    blockId: StringInput,
    headingTexts: StringArrayInput,
    headingTypes: HeadingTypeArrayInput.optional(),
    children: JsonArrayInput,
    pageSize: OptionalNumber,
  })
  .strict();

export const DownloadAndExtractFileParamsSchema = z
  .object({
    url: StringInput,
    filename: z.string().optional(),
    contentType: z.string().optional(),
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
