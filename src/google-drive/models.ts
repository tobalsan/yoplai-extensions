import { z } from "zod";

export const GoogleDriveConfigSchema = z.object({
  allowWrite: z.boolean().default(false).describe("Allow creating and editing Drive files and Google Sheets. Reconnect Google after enabling."),
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
export const SheetsUpdateRangeParamsSchema = z.object({
  spreadsheetId: z.string().min(1),
  range: z.string().min(1).describe("A1 notation, e.g. 'Clients'!A2:C10."),
  values: z.array(z.array(SheetCellSchema).min(1)).min(1),
});
export const SheetsAppendRowsParamsSchema = z.object({
  spreadsheetId: z.string().min(1),
  range: z.string().min(1).describe("A1 notation identifying the table to append to, e.g. 'Clients'!A:C."),
  rows: z.array(z.array(SheetCellSchema).min(1)).min(1),
});
export type CreateFolderParams = z.infer<typeof CreateFolderParamsSchema>;
export type CreateFileParams = z.infer<typeof CreateFileParamsSchema>;
export type UpdateFileContentParams = z.infer<typeof UpdateFileContentParamsSchema>;
export type RenameMoveFileParams = z.infer<typeof RenameMoveFileParamsSchema>;
export type SheetsUpdateRangeParams = z.infer<typeof SheetsUpdateRangeParamsSchema>;
export type SheetsAppendRowsParams = z.infer<typeof SheetsAppendRowsParamsSchema>;
