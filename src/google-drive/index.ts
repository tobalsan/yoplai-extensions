import { defineToolExtension } from "../tool-extension.js";
import type { ResolvedOAuth } from "../tool-extension.js";
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
  ListFilesParamsSchema,
  ReadFileParamsSchema,
  SearchFilesParamsSchema,
  ValidateParamsSchema,
} from "./models.js";

/** Documented not-connected signal — never a raw 401. */
function notConnected(oauth: ResolvedOAuth | undefined) {
  return {
    connected: false,
    provider: "google",
    reason: oauth && !oauth.connected ? oauth.reason : "not_connected",
    message:
      oauth && !oauth.connected
        ? oauth.message
        : "Google Drive is not connected. Connect a Google account (Just me or Whole team) in the agent's Google Drive settings.",
    authorizeUrl:
      oauth && !oauth.connected && "authorizeUrl" in oauth ? oauth.authorizeUrl : undefined,
  };
}

export default defineToolExtension({
  id: "googleDrive",
  displayName: "Google Drive",
  description:
    "Google Drive access (read-only by default, optional file and Sheets writes) via Google OAuth: connect your own account (Just me) or a shared team account (Whole team). List and search files, and read a file's text content.",
  systemPrompt: `Use this extension for Google Drive access. Write tools are available only when allowWrite is enabled; read the target before writing, confirm when ambiguous, and report what changed.

Authentication uses the requester's own Google connection, falling back to the team connection. If a tool reports not connected, share the connect link it returns (or tell the user to connect Google Drive in the agent's settings) — do not attempt to guess or supply credentials.

Tools:
- googleDrive_list_files: list accessible Drive files, optionally filtered by a name substring; supports pageSize and pageToken pagination
- googleDrive_search_files: search Drive using the Drive query (\`q\`) syntax, e.g. "name contains 'report' and mimeType='application/pdf'"; supports pagination
- googleDrive_read_file: download a file by id and extract its text (Google Docs/Sheets/Slides are exported to text/CSV; PDF and DOCX are text-extracted)
- googleDrive_validate: check that the Google Drive connection is live`,
  configSchema: GoogleDriveConfigSchema,
  configFieldTitles: { allowWrite: "Enable creating and writing files" },
  requiredSecrets: [],
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

    const tools: import("../tool-extension.js").ToolExtensionTool[] = [
      {
        name: "list_files",
        description:
          "List Google Drive files, optionally filtered by a name substring. Supports pageSize and pageToken pagination.",
        parameters: ListFilesParamsSchema,
        execute: async (params) => {
          const parsed = ListFilesParamsSchema.parse(params);
          if (!connected) return notConnected(oauth);
          const client = new GoogleDriveClient(connected.accessToken);
          return client.listFiles(parsed);
        },
      },
      {
        name: "search_files",
        description:
          "Search Google Drive using the Drive query (`q`) syntax. Supports pageSize and pageToken pagination.",
        parameters: SearchFilesParamsSchema,
        execute: async (params) => {
          const parsed = SearchFilesParamsSchema.parse(params);
          if (!connected) return notConnected(oauth);
          const client = new GoogleDriveClient(connected.accessToken);
          return client.searchFiles(parsed);
        },
      },
      {
        name: "read_file",
        description:
          "Download a Google Drive file by id and extract its text content. Google Workspace files are exported to text/CSV; PDF and DOCX are text-extracted.",
        parameters: ReadFileParamsSchema,
        execute: async (params) => {
          const parsed = ReadFileParamsSchema.parse(params);
          if (!connected) return notConnected(oauth);
          const client = new GoogleDriveClient(connected.accessToken);
          return client.readFile(parsed);
        },
      },
      {
        name: "validate",
        description:
          "Validate the Google Drive connection. Returns connected + the Google account when a fresh token is available, or a clear not-connected signal otherwise.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          if (!connected) return notConnected(oauth);

          const client = new GoogleDriveClient(connected.accessToken);
          const user = await client.about();
          return {
            connected: true,
            provider: "google",
            account: user.emailAddress ?? connected.account,
            displayName: user.displayName,
            scopes: connected.scopes,
          };
        },
      },
    ];
    function writeTool<T extends z.ZodTypeAny>(name: string, description: string, schema: T, action: (client: GoogleDriveClient, params: z.infer<T>) => Promise<unknown>) {
      return {
        name, description, parameters: schema,
        execute: async (params: unknown) => {
          const parsed = schema.parse(params);
          if (!connected) return notConnected(oauth);
          return action(new GoogleDriveClient(connected.accessToken), parsed);
        },
      };
    }
    if (config.merged.allowWrite === true) {
      tools.push(
        writeTool("create_folder", "Create a Drive folder, optionally inside a parent folder.", CreateFolderParamsSchema, (client, params) => client.createFolder(params)),
        writeTool("create_file", "Create a text/CSV file; optionally convert it to a Google Doc or Sheet.", CreateFileParamsSchema, (client, params) => client.createFile(params)),
        writeTool("update_file_content", "Overwrite a file's content; Google Docs accept text and Sheets accept CSV. Read the target first.", UpdateFileContentParamsSchema, (client, params) => client.updateFileContent(params)),
        writeTool("rename_move_file", "Rename or move a Drive file. Supply name and/or parent changes.", RenameMoveFileParamsSchema, (client, params) => client.renameMoveFile(params)),
        writeTool("sheets_update_range", "Update Google Sheet cells using an A1 range and row arrays; values use USER_ENTERED interpretation.", SheetsUpdateRangeParamsSchema, (client, params) => client.sheetsUpdateRange(params)),
        writeTool("sheets_append_rows", "Append row arrays to a Google Sheet table using an A1 range and USER_ENTERED values.", SheetsAppendRowsParamsSchema, (client, params) => client.sheetsAppendRows(params)),
      );
    }
    return tools.map((tool) => ({
      ...tool,
      execute: async (params: unknown) => {
        try {
          return await tool.execute(params);
        } catch (error) {
          if (error instanceof GoogleDriveRequestError && [401, 403, 429].includes(error.status)) {
            const rateLimited = error.status === 429 || (error.status === 403 && /rate.?limit|quota|daily.?limit/i.test(error.responseBody));
            return {
              connected: false,
              provider: "google",
              reason: rateLimited ? "rate_limited" : error.status === 403 ? "insufficient_scope" : "expired",
              message: rateLimited ? "Google Drive is temporarily rate limited. Wait and retry."
                : error.status === 403 ? "Google Drive needs additional Google permission. Reconnect Google and approve the configured access."
                : "Google access has expired. Reconnect Google to continue.",
            };
          }
          throw error;
        }
      },
    }));
  },
});
