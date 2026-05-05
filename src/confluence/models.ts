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
    pageId: StringInput,
    bodyFormat: BodyFormatSchema.optional(),
  })
  .strict();

export const GetPageChildrenParamsSchema = z
  .object({
    pageId: StringInput,
    limit: OptionalPositiveInteger,
    cursor: OptionalString,
  })
  .strict();

export const GetPageAncestorsParamsSchema = z
  .object({
    pageId: StringInput,
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

export const ValidateParamsSchema = z.object({}).strict();

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceBodyFormat = z.infer<typeof BodyFormatSchema>;
