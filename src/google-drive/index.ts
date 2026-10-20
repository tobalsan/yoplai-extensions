import { defineToolExtension, notConnected } from "../tool-extension.js";
import type { ToolExecutionContext, ToolExtensionTool } from "../tool-extension.js";
import { googleFailureReason, googleOAuthProvider } from "../google-oauth-provider.js";
import { z } from "zod";
import { GoogleDriveClient, GoogleDriveRequestError } from "./client.js";
import { slidesCreate, slidesGet, slidesBatchUpdate } from "./slides.js";
import { SlidesCreateParamsSchema, SlidesCreateResultSchema, SlidesGetParamsSchema, SlidesGetResultSchema, SlidesBatchUpdateParamsSchema, SlidesBatchUpdateResultSchema } from "./slides-models.js";
import { renderSlides } from "./slides-render.js";
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
    "Google Drive access (read-only by default, optional file, Sheets and Slides writes) via Google OAuth: connect your own account (Just me) or a shared team account (Whole team). List, search, read text, download files, and create, edit or render native Google Slides decks.",
  systemPrompt: `Use this extension for Google Drive access. Write tools are available only when allowWrite is enabled; read the target before writing, confirm when ambiguous, and report what changed.

Authentication uses the requester's own Google connection, falling back to the team connection. If a tool reports not connected, share the connect link it returns (or tell the user to connect Google Drive in the agent's settings) — do not attempt to guess or supply credentials.

Use pageSize and pageToken for file-list and search pagination. Drive searches use the Drive query (\`q\`) syntax, e.g. "name contains 'report' and mimeType='application/pdf'". Use rowOffset, maxRows, and columns to limit large Sheets tabs.

For Docs, Sheets and binary files needing layout, headers, footers, images or formatting, use googleDrive_download_file, edit the returned local path, then googleDrive_save_file. For native Google Slides layout and style, use Slides tools to edit in place. googleDrive_read_file returns extracted text only. Use send_file to deliver the edited local file to the user where useful. Save files only from the current conversation folder. Downloads are limited to 25 MiB for binary media and Google's 10 MB native export limit.

allowWrite retains drive.file access: create new copies by default; replacing files requires app-created or explicitly app-authorized files. Drive media replacements cannot overwrite arbitrary existing user files; Slides API edits use the presentations scope and the user's existing edit permission. Native Google Docs/Sheets/Slides stay native when replaced with the matching Office format. A file-permission refusal needs a copy or access change, not an OAuth reconnect.

Sheets tools accept spreadsheetId or spreadsheetUrl. With allowWrite: googleDrive_sheets_update_range overwrites an exact A1 range; googleDrive_sheets_append_rows appends after table data. Before writing, read the target tab or range; after writing, report the updated range and cell count.

Slides accept presentationId or presentationUrl, exactly one; Slides and Drive file links work. Start with slides_get: omitted/empty slideIds gives an overview, selected ids give details. Continue truncated results with nextSlideId as startSlideId. For a deck not created in this conversation, read it and send the returned revisionId as requiredRevisionId in slides_batch_update; if stale, read again before editing. Do not retry without the revision guard.

Deck loop: read the brand rules from the agent skill; get the page size and convert design units to slide units; build or edit; render the changed slides; look at every render and fix overlaps, cut text, wrong fonts and wrong colors; deliver the Drive link and say what changed. Use exact Google Fonts family names: unknown names silently render as Arial. Thumbnail pixels are not slide units. Render only changed slides to conserve Google's expensive-read quota (60/user/minute, 300/project/minute); after rate_limited, wait before retrying.

Images: prefer public PNG, JPEG or GIF URLs with createImage. Private Drive links, local paths and SVG files are invalid createImage sources. For a local/private logo or chat image, copy it into the conversation folder root, then use slides_create with local images; it imports a 16:9 deck with aspect-preserving image boxes in points on a 720 x 405 pt page. Local image insertion is supported at creation only; existing decks need public image URLs. Add text and shapes with slides_batch_update after creation. If creation inspection fails, use the returned id/link with slides_get; never create a duplicate.

Chat Office uploads are read-only: copy them into the conversation folder root before save_file. Use convert: true only on a new DOCX/XLSX/PPTX copy; export native decks with download_file format pdf or the default Office format.`,
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
        "https://www.googleapis.com/auth/presentations",
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
      tool("read_file", "Download a Google Drive file by id and extract its text content. Google Workspace files are exported to text/CSV; PDF, DOCX and PPTX are text-extracted; PPTX text includes slide numbers and speaker notes.", ReadFileParamsSchema, (client, params) => client.readFile(params), ReadFileResultSchema),
      tool("download_file", "Download the original file into this conversation for editing; native Docs/Sheets/Slides export as Office files by default, or PDF with format pdf.", z.object({ fileId: z.string().min(1), format: z.enum(["office", "pdf"]).default("office") }), (client, params, _connected, context) => client.downloadFile(params.fileId, context, params.format)),
      tool("sheets_list_spreadsheets", "List Google Sheets accessible to the connected account, optionally filtered by name. Supports pageSize and pageToken pagination.", SheetsListSpreadsheetsParamsSchema, (client, params) => client.sheetsListSpreadsheets(params)),
      tool("sheets_inspect", "Inspect a spreadsheet's tabs, dimensions, and detected headers.", SheetsInspectParamsSchema, (client, params) => client.sheetsInspect(params)),
      tool("sheets_read_sheet", "Read one worksheet tab as detected headers plus row objects. Supports rowOffset, maxRows, and columns for large tabs.", SheetsReadSheetParamsSchema, (client, params) => client.sheetsReadSheet(params)),
      tool("sheets_read_range", "Read an arbitrary A1 range from a spreadsheet as raw values.", SheetsReadRangeParamsSchema, (client, params) => client.sheetsReadRange(params)),
      tool("slides_get", "Read a Google Slides deck overview or selected slide details, with revision and continuation for large decks.", SlidesGetParamsSchema, (client, params, _connected, context) => slidesGet(params, (url, init) => client.request(url, init), context), SlidesGetResultSchema),
      tool("slides_render", "Render Google Slides to PNG files in this conversation; select changed slides to conserve quota. Pixels are not slide units.", z.object({ presentationId: z.string().min(1).optional(), presentationUrl: z.string().min(1).optional(), slideIds: z.array(z.string().min(1)).optional() }), (client, params, _connected, context) => renderSlides(params, context, (url, init) => client.request(url, init)), z.object({ presentationId: z.string(), slides: z.array(z.object({ slideId: z.string(), slideNumber: z.number(), path: z.string(), width: z.number(), height: z.number() })) })),
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
        tool("save_file", "Save a conversation file to Drive: create a copy with name and optional parentId, or replace an app-accessible fileId while preserving its format. With a new copy, convert: true imports DOCX/XLSX/PPTX as native Docs/Sheets/Slides.", z.object({ path: z.string().min(1), fileId: z.string().min(1).optional(), name: z.string().min(1).optional(), parentId: z.string().min(1).optional(), convert: z.boolean().optional() }), (client, params, _connected, context) => client.saveFile(params, context)),
        tool("slides_create", "Create a native Google Slides deck in an optional Drive folder; local PNG/JPEG/GIF images use conversation-root paths and point geometry on a 720 x 405 page.", SlidesCreateParamsSchema, (client, params, _connected, context) => slidesCreate(params, context, (url, init) => client.request(url, init)), SlidesCreateResultSchema),
        tool("slides_batch_update", "Send any Google Slides request objects unchanged. Read existing decks first and pass requiredRevisionId to guard concurrent edits.", SlidesBatchUpdateParamsSchema, (client, params, _connected, context) => slidesBatchUpdate(params, (url, init) => client.request(url, init), context), SlidesBatchUpdateResultSchema),
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
          if (error instanceof z.ZodError) throw Object.assign(error, { status: 400 });
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
