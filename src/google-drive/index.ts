import { defineToolExtension } from "../tool-extension.js";
import type { ResolvedOAuth } from "../tool-extension.js";
import { GoogleDriveClient } from "./client.js";
import {
  GoogleDriveConfigSchema,
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
        : "Google Drive is not connected. Click Connect Google Drive in settings.",
    authorizeUrl:
      oauth && !oauth.connected && "authorizeUrl" in oauth ? oauth.authorizeUrl : undefined,
  };
}

/**
 * googleDrive read-only extension. It declares an `oauth` requirement for Google
 * Drive and exposes list/search/read tools plus `validate`. Every tool consumes
 * the fresh access token injected via `config.oauth` at tool-build time; when no
 * valid connection exists it returns the documented not-connected signal instead
 * of surfacing a raw 401. Read-only: only `drive.readonly` scope, no mutations.
 */
export default defineToolExtension({
  id: "googleDrive",
  displayName: "Google Drive",
  description:
    "Read-only Google Drive access via per-agent OAuth. List and search files, and read a file's text content.",
  systemPrompt: `Use this extension for read-only Google Drive access.

Authentication is handled by per-agent OAuth. If a tool reports not connected, tell the user to click "Connect Google Drive" in settings — do not attempt to guess or supply credentials.

Tools:
- googleDrive_list_files: list accessible Drive files, optionally filtered by a name substring; supports pageSize and pageToken pagination
- googleDrive_search_files: search Drive using the Drive query (\`q\`) syntax, e.g. "name contains 'report' and mimeType='application/pdf'"; supports pagination
- googleDrive_read_file: download a file by id and extract its text (Google Docs/Sheets/Slides are exported to text/CSV; PDF and DOCX are text-extracted)
- googleDrive_validate: check that the Google Drive connection is live`,
  configSchema: GoogleDriveConfigSchema,
  requiredSecrets: [],
  oauth: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected === true ? oauth : undefined;

    return [
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
  },
});
