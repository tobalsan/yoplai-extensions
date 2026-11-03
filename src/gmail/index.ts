import { defineToolExtension, notConnected } from "../tool-extension.js";
import type { ToolExecutionContext } from "../tool-extension.js";
import { z } from "zod";
import { googleFailureReason, googleOAuthProvider } from "../google-oauth-provider.js";
import { GmailClient, GmailRequestError } from "./client.js";
import {
  CreateDraftParamsSchema,
  CreateLabelParamsSchema,
  DeleteDraftParamsSchema,
  DownloadAttachmentParamsSchema,
  GetThreadParamsSchema,
  GmailConfigSchema,
  LabelMessageParamsSchema,
  LabelThreadParamsSchema,
  ListDraftsParamsSchema,
  ListLabelsParamsSchema,
  SearchThreadsParamsSchema,
  SendDraftParamsSchema,
  SendEmailParamsSchema,
  UpdateDraftParamsSchema,
} from "./models.js";

const FAILURE_MESSAGES = {
  expired: "Gmail access has expired. Reconnect Google to continue.",
  rate_limited: "Gmail is temporarily rate limited. Wait and retry.",
  insufficient_scope: "Gmail needs additional Google permission. Reconnect Google and approve Gmail access.",
};

const NOT_CONNECTED_MESSAGE =
  "Gmail is not connected. Connect a Google account (Just me or Whole team) in the agent's Gmail settings.";

export default defineToolExtension({
  id: "gmail",
  displayName: "Gmail",
  description: "Gmail mailbox tools via Google OAuth: connect your own account (Just me) or a shared team account (Whole team).",
  systemPrompt: "Use Gmail-compatible query syntax. Gmail content is returned only for this tool call; never repeat it unnecessarily. Send tools exist only when allowSend is enabled. If they are not in your tool list, do not claim an email was sent. When you have them, confirm the recipients and the attachment with the user before each send, unless a scheduled job states the send rule. Attachments download to the conversation folder, up to 25 MiB each. Drafts and sends accept at most 10 files from that folder; total original attachment bytes must not exceed 25 MB (25,000,000 bytes), and the full MIME message including bodies, headers, and base64 line wrapping must not exceed 36,700,160 bytes. Omit attachments on draft updates to keep existing files; [] removes them and a list replaces them.",
  configSchema: GmailConfigSchema,
  configFieldTitles: { allowSend: "Enable sending email" },
  requiredSecrets: [],
  oauthProviders: [googleOAuthProvider],
  oauth: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected ? oauth : undefined;
    const client = connected ? new GmailClient(connected.accessToken) : undefined;

    const run = <T>(
      schema: { parse(value: unknown): T },
      action: (client: GmailClient, value: T, context?: ToolExecutionContext) => Promise<unknown>,
    ) => async (value: unknown, context?: ToolExecutionContext) => {
      if (!client || !connected) {
        return notConnected("google", NOT_CONNECTED_MESSAGE, oauth);
      }

      const parsed = schema.parse(value);
      try {
        const account = await client.account(context);
        if (
          connected.account
          && account
          && connected.account.toLowerCase() !== account.toLowerCase()
        ) {
          return {
            isError: true,
            connected: false,
            provider: "google",
            reason: "wrong_account",
            message: "The Gmail mailbox does not match the connected Google account. Reconnect the intended account.",
            account,
          };
        }

        const result = await action(client, parsed, context);
        return {
          ...(result as object),
          account: account || connected.account || null,
        };
      } catch (error) {
        if (error instanceof GmailRequestError && (error.status === 401 || error.status === 403)) {
          const reason = googleFailureReason(error.status, error.reason ?? "")!;
          return { isError: true, connected: false, provider: "google", reason, message: FAILURE_MESSAGES[reason] };
        }
        throw error;
      }
    };

    return [
      {
        name: "create_draft",
        description: "Create an email draft without sending it.",
        parameters: CreateDraftParamsSchema,
        execute: run(CreateDraftParamsSchema, (gmail, params, context) => gmail.createDraft(params, context)),
      },
      {
        name: "update_draft",
        description: "Update an existing draft by Draft ID (from list_drafts without query). Omitted fields keep current values, including attachments; attachments: [] removes all, a list replaces them. HTML body is dropped unless htmlBody is resent.",
        parameters: UpdateDraftParamsSchema,
        execute: run(UpdateDraftParamsSchema, (gmail, params, context) => gmail.updateDraft(params, context)),
      },
      {
        name: "delete_draft",
        description: "Permanently delete a draft by Draft ID (from list_drafts without query). Not recoverable.",
        parameters: DeleteDraftParamsSchema,
        execute: run(DeleteDraftParamsSchema, (gmail, params) => gmail.deleteDraft(params)),
      },
      {
        name: "list_drafts",
        description: "List drafts with pagination. With query, Gmail REST searches draft messages; ids are message IDs and draftIdKind reports this deviation.",
        parameters: ListDraftsParamsSchema,
        execute: run(ListDraftsParamsSchema, (gmail, params) => gmail.listDrafts(params)),
      },
      {
        name: "get_thread",
        description: "Get a Gmail thread and its messages.",
        parameters: GetThreadParamsSchema,
        execute: run(GetThreadParamsSchema, (gmail, params) => gmail.getThread(params)),
      },
      {
        name: "search_threads",
        description: "Search Gmail threads using Gmail query syntax.",
        parameters: SearchThreadsParamsSchema,
        execute: run(SearchThreadsParamsSchema, (gmail, params) => gmail.searchThreads(params)),
      },
      {
        name: "label_thread",
        description: "Add labels to a thread.",
        parameters: LabelThreadParamsSchema,
        execute: run(LabelThreadParamsSchema, (gmail, params) => gmail.labelThread(params)),
      },
      {
        name: "unlabel_thread",
        description: "Remove labels from a thread.",
        parameters: LabelThreadParamsSchema,
        execute: run(LabelThreadParamsSchema, (gmail, params) => gmail.labelThread(params, true)),
      },
      {
        name: "list_labels",
        description: "List user-defined Gmail labels with pagination; well-known system IDs can still be used in label mutations.",
        parameters: ListLabelsParamsSchema,
        execute: run(ListLabelsParamsSchema, (gmail, params) => gmail.listLabels(params)),
      },
      {
        name: "label_message",
        description: "Add labels to a message.",
        parameters: LabelMessageParamsSchema,
        execute: run(LabelMessageParamsSchema, (gmail, params) => gmail.labelMessage(params)),
      },
      {
        name: "unlabel_message",
        description: "Remove labels from a message.",
        parameters: LabelMessageParamsSchema,
        execute: run(LabelMessageParamsSchema, (gmail, params) => gmail.labelMessage(params, true)),
      },
      {
        name: "create_label",
        description: "Create a Gmail label.",
        parameters: CreateLabelParamsSchema,
        execute: run(CreateLabelParamsSchema, (gmail, params) => gmail.createLabel(params)),
      },
      {
        name: "download_attachment",
        description: "Download an attachment from a message into the current conversation folder (25 MiB maximum). Pass messageId, attachmentId, and partId from get_thread attachments. If partId is unavailable, pass filename and size instead; they must identify one attachment. Gmail attachment IDs can change between reads.",
        parameters: DownloadAttachmentParamsSchema,
        outputSchema: z.object({ path: z.string(), name: z.string(), mimeType: z.string(), bytes: z.number(), account: z.string().nullable() }),
        execute: run(DownloadAttachmentParamsSchema, (gmail, params, context) => gmail.downloadAttachment(params, context)),
      },
      ...(config.merged.allowSend === true ? [
        {
          name: "send_email",
          description: "Send an email with optional conversation-folder attachments. Confirm recipients and attachment with the user before sending, unless a scheduled job states its send rule.",
          parameters: SendEmailParamsSchema,
          outputSchema: z.object({ messageId: z.string(), threadId: z.string().nullable(), account: z.string().nullable() }),
          execute: run(SendEmailParamsSchema, (gmail, params, context) => gmail.sendEmail(params, context)),
        },
        {
          name: "send_draft",
          description: "Send an existing draft. Use a Draft ID from list_drafts without query; query results contain message IDs, which Gmail rejects with 404. Confirm recipients and attachment with the user before sending, unless a scheduled job states its send rule.",
          parameters: SendDraftParamsSchema,
          outputSchema: z.object({ messageId: z.string(), threadId: z.string().nullable(), account: z.string().nullable() }),
          execute: run(SendDraftParamsSchema, (gmail, params, context) => gmail.sendDraft(params, context)),
        },
      ] : []),
    ];
  },
});
