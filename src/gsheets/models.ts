import { z } from "zod";

export const GSheetsConfigSchema = z.object({
  serviceAccountJson: z
    .string()
    .min(1)
    .describe(
      "Google service account credentials JSON (the full key file contents), created in Google Cloud Console with Sheets API access shared to the account.",
    ),
  timeoutMs: z
    .number()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for Google Sheets API calls. Defaults to 30000."),
});

export type GSheetsConfig = z.infer<typeof GSheetsConfigSchema>;

export const EmptyParamsSchema = z.object({});

export const ListSpreadsheetsParamsSchema = z.object({
  query: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).optional().default(50),
  pageToken: z.string().min(1).optional(),
});

export const SpreadsheetRefSchema = z.object({
  spreadsheetId: z.string().optional(),
  spreadsheetUrl: z.string().optional(),
});

export const InspectSpreadsheetParamsSchema = SpreadsheetRefSchema.extend({
  maxHeaderScanRows: z.number().int().min(1).max(50).optional().default(10),
});

export const ReadSheetParamsSchema = SpreadsheetRefSchema.extend({
  tabName: z.string().min(1),
  headerRowIndex: z.number().int().min(0).optional().default(0),
  rowOffset: z.number().int().min(0).optional().default(0),
  maxRows: z.number().int().min(1).max(5000).optional(),
  columns: z.array(z.string().min(1)).optional(),
});

export const ReadRangeParamsSchema = SpreadsheetRefSchema.extend({
  range: z.string().min(1),
  majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().default("ROWS"),
});

export const AppendRowsParamsSchema = SpreadsheetRefSchema.extend({
  range: z
    .string()
    .min(1)
    .describe("A1 notation of the table range to append after, e.g. 'Sheet1!A:D'."),
  values: z
    .array(z.array(z.string()))
    .min(1)
    .describe("Rows to append, each row an array of cell strings."),
  valueInputOption: z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED"),
});

export const UpdateRangeParamsSchema = SpreadsheetRefSchema.extend({
  range: z.string().min(1).describe("A1 notation of the exact target range to overwrite."),
  values: z
    .array(z.array(z.string()))
    .min(1)
    .describe("Rows to write, each row an array of cell strings."),
  valueInputOption: z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED"),
});

export type ListSpreadsheetsParams = z.infer<typeof ListSpreadsheetsParamsSchema>;
export type InspectSpreadsheetParams = z.infer<typeof InspectSpreadsheetParamsSchema>;
export type ReadSheetParams = z.infer<typeof ReadSheetParamsSchema>;
export type ReadRangeParams = z.infer<typeof ReadRangeParamsSchema>;
export type AppendRowsParams = z.infer<typeof AppendRowsParamsSchema>;
export type UpdateRangeParams = z.infer<typeof UpdateRangeParamsSchema>;
