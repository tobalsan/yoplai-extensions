import { z } from "zod";

export const GoogleDriveConfigSchema = z.object({
  allowWrite: z.boolean().default(false).describe("Allow creating and editing Drive files, Google Sheets and Google Slides."),
}).passthrough();
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>;

export const ValidateParamsSchema = z.object({}).strict();
export type ValidateParams = z.infer<typeof ValidateParamsSchema>;

/** List files, optionally filtered by a name substring. */
export const ListFilesParamsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional filter matched against the file name (substring, case-insensitive)."),
  pageSize: z.number().int().min(1).max(100).optional().default(50),
  pageToken: z
    .string()
    .optional()
    .describe("Opaque token from a previous list_files/search_files response to fetch the next page."),
});
export type ListFilesParams = z.infer<typeof ListFilesParamsSchema>;

/** Full Drive query search using Google Drive's `q` search syntax. */
export const SearchFilesParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Google Drive search query using the Drive `q` syntax, e.g. \"name contains 'report' and mimeType='application/pdf'\".",
    ),
  pageSize: z.number().int().min(1).max(100).optional().default(50),
  pageToken: z.string().optional(),
});
export type SearchFilesParams = z.infer<typeof SearchFilesParamsSchema>;

/** Download a file and extract its text content. */
export const ReadFileParamsSchema = z.object({
  fileId: z.string().min(1).describe("The Drive file id to download and extract text from."),
});
export type ReadFileParams = z.infer<typeof ReadFileParamsSchema>;

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

/** Google Drive `about` endpoint used to prove the token works end-to-end. */
export const DRIVE_ABOUT_URL = `${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`;

export const DRIVE_FILES_URL = `${DRIVE_API_BASE}/files`;

export function driveFileMediaUrl(fileId: string): string {
  return `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`;
}

export function driveFileExportUrl(fileId: string, mimeType: string): string {
  return `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`;
}

/** Fields requested for file listings. */
export const DRIVE_FILE_FIELDS =
  "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken";

/**
 * Native Google Workspace types are not downloadable as-is; they must be
 * exported to a concrete format. Map each editor type to the text-friendly
 * export MIME we request.
 */
export const GOOGLE_WORKSPACE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export const CreateFolderParamsSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().min(1).optional(),
});
export const CreateFileParamsSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  mimeType: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  convertTo: z.enum(["doc", "sheet"]).optional(),
});
export const UpdateFileContentParamsSchema = z.object({
  fileId: z.string().min(1),
  content: z.string(),
});
export const RenameMoveFileParamsSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1).optional(),
  addParentId: z.string().min(1).optional(),
  removeParentId: z.string().min(1).optional(),
});
const SheetCellSchema = z.union([z.string(), z.number(), z.boolean()]);
const SpreadsheetRefSchema = z.object({
  spreadsheetId: z.string().min(1).optional().describe("Spreadsheet id; or pass spreadsheetUrl."),
  spreadsheetUrl: z.string().min(1).optional().describe("Full Google Sheets URL; used when spreadsheetId is omitted."),
});
const ValueInputOptionSchema = z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED");
export const SheetsListSpreadsheetsParamsSchema = z.object({
  query: z.string().optional().describe("Optional spreadsheet name substring."),
  pageSize: z.number().int().min(1).max(100).optional().default(50),
  pageToken: z.string().min(1).optional(),
});
export const SheetsInspectParamsSchema = SpreadsheetRefSchema.extend({
  maxHeaderScanRows: z.number().int().min(1).max(50).optional().default(10),
});
export const SheetsReadSheetParamsSchema = SpreadsheetRefSchema.extend({
  tabName: z.string().min(1),
  headerRowIndex: z.number().int().min(0).optional().default(0).describe("1-based header row; 0 auto-detects."),
  rowOffset: z.number().int().min(0).optional().default(0),
  maxRows: z.number().int().min(1).max(5000).optional(),
  columns: z.array(z.string().min(1)).optional(),
});
export const SheetsReadRangeParamsSchema = SpreadsheetRefSchema.extend({
  range: z.string().min(1).describe("A1 notation, e.g. 'Clients'!A1:C10."),
  majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().default("ROWS"),
});
export const SheetsUpdateRangeParamsSchema = SpreadsheetRefSchema.extend({
  range: z.string().min(1).describe("A1 notation, e.g. 'Clients'!A2:C10."),
  values: z.array(z.array(SheetCellSchema).min(1)).min(1),
  valueInputOption: ValueInputOptionSchema,
});
export const SheetsAppendRowsParamsSchema = SpreadsheetRefSchema.extend({
  range: z.string().min(1).describe("A1 notation identifying the table to append to, e.g. 'Clients'!A:C."),
  rows: z.array(z.array(SheetCellSchema).min(1)).min(1),
  valueInputOption: ValueInputOptionSchema,
});
export type CreateFolderParams = z.infer<typeof CreateFolderParamsSchema>;
export type CreateFileParams = z.infer<typeof CreateFileParamsSchema>;
export type UpdateFileContentParams = z.infer<typeof UpdateFileContentParamsSchema>;
export type RenameMoveFileParams = z.infer<typeof RenameMoveFileParamsSchema>;
export type SheetsUpdateRangeParams = z.infer<typeof SheetsUpdateRangeParamsSchema>;
export type SheetsAppendRowsParams = z.infer<typeof SheetsAppendRowsParamsSchema>;
export type SheetsListSpreadsheetsParams = z.infer<typeof SheetsListSpreadsheetsParamsSchema>;
export type SheetsInspectParams = z.infer<typeof SheetsInspectParamsSchema>;
export type SheetsReadSheetParams = z.infer<typeof SheetsReadSheetParamsSchema>;
export type SheetsReadRangeParams = z.infer<typeof SheetsReadRangeParamsSchema>;

export const SearchFilesResultSchema = z.object({
  files: z.array(z.object({
    id: z.string(), name: z.string(), mimeType: z.string().nullable(), modifiedTime: z.string().nullable(),
    size: z.number().nullable(), webViewLink: z.string().nullable(),
  })),
  nextPageToken: z.string().nullable(),
});
export const ReadFileResultSchema = z.object({
  fileId: z.string(), name: z.string(), mimeType: z.string().nullable(),
  text: z.string(), bytes: z.number(), exported: z.boolean(),
});
