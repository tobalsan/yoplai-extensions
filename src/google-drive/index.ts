import { defineToolExtension, notConnected } from "../tool-extension.js";
import type { ToolExecutionContext, ToolExtensionTool } from "../tool-extension.js";
import { googleFailureReason, googleOAuthProvider } from "../google-oauth-provider.js";
import { z } from "zod";
import { GoogleDriveClient, GoogleDriveRequestError } from "./client.js";
import {
  GoogleDriveConfigSchema,
  CreateFolderParamsSchema,
  CreateFileParamsSchema,
  UpdateFileContentParamsSchema,
  RenameMoveFileParamsSchema,
  SheetsUpdateRangeParamsSchema,
  SheetsAppendRowsParamsSchema,
  SheetsListSpreadsheetsParamsSchema,
  SheetsInspectParamsSchema,
  SheetsReadSheetParamsSchema,
  SheetsReadRangeParamsSchema,
  ListFilesParamsSchema,
  ReadFileParamsSchema,
  SearchFilesParamsSchema,
  SearchFilesResultSchema,
  ReadFileResultSchema,
  ValidateParamsSchema,
} from "./models.js";

/** Documented not-connected signal — never a raw 401. */
const FAILURE_MESSAGES = {
  rate_limited: "Google Drive is temporarily rate limited. Wait and retry.",
  insufficient_scope: "Google Drive needs additional Google permission. Reconnect Google and approve the configured access.",
  expired: "Google access has expired. Reconnect Google to continue.",
};

const NOT_CONNECTED_MESSAGE =
  "Google Drive is not connected. Connect a Google account (Just me or Whole team) in the agent's Google Drive settings.";

export default defineToolExtension({
  id: "googleDrive",
  displayName: "Google Drive",
  description:
    "Google Drive access (read-only by default, optional file and Sheets writes) via Google OAuth: connect your own account (Just me) or a shared team account (Whole team). List, search, read text, or download original files for editing.",
  systemPrompt: `Use this extension for Google Drive access. Write tools are available only when allowWrite is enabled; read the target before writing, confirm when ambiguous, and report what changed.

Authentication uses the requester's own Google connection, falling back to the team connection. If a tool reports not connected, share the connect link it returns (or tell the user to connect Google Drive in the agent's settings) — do not attempt to guess or supply credentials.

Use pageSize and pageToken for file-list and search pagination. Drive searches use the Drive query (\`q\`) syntax, e.g. "name contains 'report' and mimeType='application/pdf'". Use rowOffset, maxRows, and columns to limit large Sheets tabs.

For layout, headers, footers, images or formatting, use googleDrive_download_file, edit the returned local path, then googleDrive_save_file. googleDrive_read_file returns extracted text only. Use send_file to deliver the edited local file to the user where useful. Save files only from the current conversation folder. Downloads are limited to 25 MiB for binary media and Google's 10 MB native export limit.

allowWrite retains drive.file access: create new copies by default; replacing files requires app-created or explicitly app-authorized files. It cannot overwrite arbitrary existing user files. Native Google Docs/Sheets/Slides stay native when replaced with the matching Office format. A file-permission refusal needs a copy or access change, not an OAuth reconnect.

Sheets tools accept spreadsheetId or spreadsheetUrl. With allowWrite: googleDrive_sheets_update_range overwrites an exact A1 range; googleDrive_sheets_append_rows appends after table data. Before writing, read the target tab or range; after writing, report the updated range and cell count.`,
  configSchema: GoogleDriveConfigSchema,
  configFieldTitles: { allowWrite: "Enable creating and writing files" },
  requiredSecrets: [],
  oauthProviders: [googleOAuthProvider],
  oauth: (config) => ({
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      ...(config.merged.allowWrite === true ? [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/spreadsheets",
      ] : []),
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  }),
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected === true ? oauth : undefined;

    function tool<T extends z.ZodTypeAny>(name: string, description: string, schema: T, action: (client: GoogleDriveClient, params: z.infer<T>, connected: { accessToken: string; account?: string; scopes: string[] }, context?: ToolExecutionContext) => Promise<unknown>, outputSchema?: z.ZodTypeAny): ToolExtensionTool {
      return {
        name, description, parameters: schema, ...(outputSchema ? { outputSchema } : {}),
        execute: async (params: unknown, context) => {
          const parsed = schema.parse(params);
          if (!connected) return notConnected("google", NOT_CONNECTED_MESSAGE, oauth);
          return action(new GoogleDriveClient(connected.accessToken), parsed, connected, context);
        },
      };
    }
    const tools: ToolExtensionTool[] = [
      tool("list_files", "List Google Drive files, optionally filtered by a name substring. Supports pageSize and pageToken pagination.", ListFilesParamsSchema, (client, params) => client.listFiles(params)),
      tool("search_files", "Search Google Drive using the Drive query (`q`) syntax. Supports pageSize and pageToken pagination.", SearchFilesParamsSchema, (client, params) => client.searchFiles(params), SearchFilesResultSchema),
      tool("read_file", "Download a Google Drive file by id and extract its text content. Google Workspace files are exported to text/CSV; PDF and DOCX are text-extracted.", ReadFileParamsSchema, (client, params) => client.readFile(params), ReadFileResultSchema),
      tool("download_file", "Download the original file into this conversation for editing; native Docs/Sheets/Slides export as Office files.", ReadFileParamsSchema, (client, params, _connected, context) => client.downloadFile(params.fileId, context)),
      tool("sheets_list_spreadsheets", "List Google Sheets accessible to the connected account, optionally filtered by name. Supports pageSize and pageToken pagination.", SheetsListSpreadsheetsParamsSchema, (client, params) => client.sheetsListSpreadsheets(params)),
      tool("sheets_inspect", "Inspect a spreadsheet's tabs, dimensions, and detected headers.", SheetsInspectParamsSchema, (client, params) => client.sheetsInspect(params)),
      tool("sheets_read_sheet", "Read one worksheet tab as detected headers plus row objects. Supports rowOffset, maxRows, and columns for large tabs.", SheetsReadSheetParamsSchema, (client, params) => client.sheetsReadSheet(params)),
      tool("sheets_read_range", "Read an arbitrary A1 range from a spreadsheet as raw values.", SheetsReadRangeParamsSchema, (client, params) => client.sheetsReadRange(params)),
      tool("validate", "Validate the Google Drive connection. Returns connected + the Google account when a fresh token is available, or a clear not-connected signal otherwise.", ValidateParamsSchema, async (client, _params, connected) => {
        const user = await client.about();
        return {
          connected: true,
          provider: "google",
          account: user.emailAddress ?? connected.account,
          displayName: user.displayName,
          scopes: connected.scopes,
        };
      }),
    ];
    if (config.merged.allowWrite === true) {
      tools.push(
        tool("save_file", "Save a conversation file to Drive: create a copy with name and optional parentId, or replace an app-accessible fileId while preserving its format.", z.object({ path: z.string().min(1), fileId: z.string().min(1).optional(), name: z.string().min(1).optional(), parentId: z.string().min(1).optional() }), (client, params, _connected, context) => client.saveFile(params, context)),
        tool("create_folder", "Create a Drive folder, optionally inside a parent folder.", CreateFolderParamsSchema, (client, params) => client.createFolder(params)),
        tool("create_file", "Create a text/CSV file; optionally convert it to a Google Doc or Sheet.", CreateFileParamsSchema, (client, params) => client.createFile(params)),
        tool("update_file_content", "Overwrite a file's content; Google Docs accept text and Sheets accept CSV. Read the target first.", UpdateFileContentParamsSchema, (client, params) => client.updateFileContent(params)),
        tool("rename_move_file", "Rename or move a Drive file. Supply name and/or parent changes.", RenameMoveFileParamsSchema, (client, params) => client.renameMoveFile(params)),
        tool("sheets_update_range", "Update Google Sheet cells using an A1 range and row arrays; valueInputOption defaults to USER_ENTERED (or RAW).", SheetsUpdateRangeParamsSchema, (client, params) => client.sheetsUpdateRange(params)),
        tool("sheets_append_rows", "Append row arrays to a Google Sheet table using an A1 range; valueInputOption defaults to USER_ENTERED (or RAW).", SheetsAppendRowsParamsSchema, (client, params) => client.sheetsAppendRows(params)),
      );
    }
    return tools.map((tool) => ({
      ...tool,
      execute: async (params: unknown, context) => {
        try {
          return await tool.execute(params, context);
        } catch (error) {
          if (error instanceof GoogleDriveRequestError && [401, 403, 429].includes(error.status)) {
            const reason = googleFailureReason(error.status, error.responseBody)!;
            if (error.status === 403 && reason === "insufficient_scope" && !/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(error.responseBody)) throw error;
            return { connected: false, provider: "google", reason, message: FAILURE_MESSAGES[reason], ...(reason === "rate_limited" ? {} : { isError: true }) };
          }
          throw error;
        }
      },
    }));
  },
});
