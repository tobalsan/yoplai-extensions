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

export const NotionConfigSchema = z.object({
  apiKey: z.string(),
  notionVersion: z.string().optional().default("2025-09-03"),
  timeoutMs: z.number().int().positive().optional().default(30_000),
});

export const ListDataSourcesParamsSchema = z
  .object({
    query: z.string().optional(),
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
    pageSize: OptionalNumber,
    startCursor: OptionalString,
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

export const DownloadAndExtractFileParamsSchema = z
  .object({
    url: StringInput,
    filename: z.string().optional(),
    contentType: z.string().optional(),
  })
  .strict();

export const ValidateParamsSchema = z.object({}).strict();

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
