import { z } from "zod";

/**
 * Accepts either a positive-integer number or its string form (config/JSON
 * schema round-trips sometimes deliver numeric params as strings).
 */
const PositiveIntFromInput = z.union([z.number().int().positive(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected positive integer" });
    return z.NEVER;
  }
  return parsed;
});

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

export const PipedriveConfigSchema = z.object({
  apiToken: z.string().min(1, "PIPEDRIVE_API_TOKEN is required"),
  domain: z.string().min(1, "PIPEDRIVE_DOMAIN is required"),
});
export type PipedriveConfig = z.infer<typeof PipedriveConfigSchema>;

export const DealStatusSchema = z.enum([
  "open",
  "won",
  "lost",
  "deleted",
  "all_not_deleted",
]);
export type DealStatus = z.infer<typeof DealStatusSchema>;

export const SortDirectionSchema = z.enum(["asc", "desc"]);

export const ListDealsParamsSchema = z
  .object({
    status: DealStatusSchema.optional().describe(
      'Deal lifecycle filter (server-side). Defaults to "open".',
    ),
    pipeline_id: PositiveIntFromInput.optional().describe("Filter by pipeline ID (server-side)."),
    stage_id: PositiveIntFromInput.optional().describe("Filter by stage ID (server-side)."),
    person_id: PositiveIntFromInput.optional().describe("Filter by linked person ID (server-side)."),
    org_id: PositiveIntFromInput.optional().describe("Filter by linked organization ID (server-side)."),
    user_id: PositiveIntFromInput.optional().describe("Filter by owner user ID (server-side)."),
    expected_close_from: DateOnly.optional().describe(
      "Only include deals whose expected close date is on or after this date (YYYY-MM-DD). Net-new close-date range filter.",
    ),
    expected_close_to: DateOnly.optional().describe(
      "Only include deals whose expected close date is on or before this date (YYYY-MM-DD). Net-new close-date range filter.",
    ),
    cursor: z.string().min(1).optional().describe("Opaque cursor from a prior page's next_cursor."),
    limit: PositiveIntFromInput.optional().describe(
      "Max deals per page, 1-500 (default 100). Pagination assembles full pages internally when a close-date range is set.",
    ),
    sort_by: z.string().min(1).optional().describe('Field to sort by (default "update_time").'),
    sort_direction: SortDirectionSchema.optional().describe('Sort direction (default "desc").'),
  })
  .strict();
export type ListDealsParams = z.infer<typeof ListDealsParamsSchema>;

/** Lean per-deal projection returned by list_deals to protect the token budget. */
export const DealSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.string().nullable(),
  stage_id: z.number().nullable(),
  pipeline_id: z.number().nullable(),
  person_id: z.number().nullable(),
  org_id: z.number().nullable(),
  user_id: z.number().nullable(),
  expected_close_date: z.string().nullable(),
  deal_url: z.string().nullable(),
});
export type DealSummary = z.infer<typeof DealSummarySchema>;

export const ListDealsResultSchema = z.object({
  deals: z.array(DealSummarySchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealsResult = z.infer<typeof ListDealsResultSchema>;

/**
 * A file/attachment linked to a deal. Lean projection over Pipedrive's file
 * record: enough metadata (name, type, size) for Sally to pick the right one,
 * plus the file id needed to download it. Read-only; nothing is parsed.
 */
export const FileSchema = z.object({
  id: z.number().describe("Pipedrive file id — pass to download_file."),
  name: z.string().describe("Human-readable file name (e.g. sale-info.xlsx)."),
  type: z
    .string()
    .nullable()
    .describe("File extension / type reported by Pipedrive (e.g. xlsx, pdf)."),
  size: z
    .number()
    .nullable()
    .describe("File size in bytes, when reported by Pipedrive."),
  deal_id: z.number().nullable().describe("The deal this file is linked to."),
  add_time: z.string().nullable().describe("When the file was uploaded (ISO-ish)."),
  url: z.string().nullable().describe("Pipedrive URL for the file, when present."),
});
export type File = z.infer<typeof FileSchema>;

export const ListDealFilesParamsSchema = z
  .object({
    deal_id: PositiveIntFromInput.describe("The deal whose files to list."),
  })
  .strict();
export type ListDealFilesParams = z.infer<typeof ListDealFilesParamsSchema>;

export const ListDealFilesResultSchema = z.object({
  files: z.array(FileSchema),
  count: z.number(),
});
export type ListDealFilesResult = z.infer<typeof ListDealFilesResultSchema>;

export const DownloadFileParamsSchema = z
  .object({
    file_id: PositiveIntFromInput.describe(
      "The Pipedrive file id to download (from list_deal_files).",
    ),
  })
  .strict();
export type DownloadFileParams = z.infer<typeof DownloadFileParamsSchema>;

/**
 * Raw, unparsed download result. Content is returned as base64 so binary
 * formats (e.g. .xlsx) survive JSON transport with byte integrity intact.
 * Downstream (Sally's workflow) decodes and parses — the extension never does.
 */
export const DownloadFileResultSchema = z.object({
  file_id: z.number(),
  name: z.string().nullable(),
  mime_type: z.string().nullable(),
  size: z.number().describe("Exact byte length of the decoded content."),
  encoding: z.literal("base64"),
  content_base64: z.string().describe("Raw file bytes, base64-encoded. Not parsed."),
});
export type DownloadFileResult = z.infer<typeof DownloadFileResultSchema>;
