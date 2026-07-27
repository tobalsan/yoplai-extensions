import { defineToolExtension } from "../tool-extension.js";
import type { ResolvedOAuth } from "../tool-extension.js";
import { GmailClient, GmailRequestError } from "./client.js";
import {
  CreateDraftParamsSchema,
  CreateLabelParamsSchema,
  GetThreadParamsSchema,
  GmailConfigSchema,
  LabelMessageParamsSchema,
  LabelThreadParamsSchema,
  ListDraftsParamsSchema,
  ListLabelsParamsSchema,
  SearchThreadsParamsSchema,
} from "./models.js";

function notConnected(oauth: ResolvedOAuth | undefined) {
  const disconnected = oauth && !oauth.connected ? oauth : undefined;
  return {
    connected: false,
    provider: "google",
    reason: disconnected?.reason ?? "not_connected",
    message: disconnected?.message ?? "Gmail is not connected. Click Connect Google in settings.",
    authorizeUrl: disconnected && "authorizeUrl" in disconnected ? disconnected.authorizeUrl : undefined,
  };
}

export default defineToolExtension({
  id: "gmail",
  displayName: "Gmail",
  description: "Gmail mailbox tools via per-agent Google OAuth.",
  systemPrompt: "Use Gmail-compatible query syntax. Gmail content is returned only for this tool call; never repeat it unnecessarily.",
  configSchema: GmailConfigSchema,
  configRoute: { path: "/agents/:agentId/extensions/gmail" },
  requiredSecrets: [],
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
      action: (client: GmailClient, value: T) => Promise<unknown>,
    ) => async (value: unknown) => {
      if (!client || !connected) {
        return notConnected(oauth);
      }

      const parsed = schema.parse(value);
      try {
        const account = await client.account();
        if (
          connected.account
          && account
          && connected.account.toLowerCase() !== account.toLowerCase()
        ) {
          return {
            connected: false,
            provider: "google",
            reason: "wrong_account",
            message: "The Gmail mailbox does not match the connected Google account. Reconnect the intended account.",
            account,
          };
        }

        const result = await action(client, parsed);
        return {
          ...(result as object),
          account: account || connected.account || null,
        };
      } catch (error) {
        if (error instanceof GmailRequestError && error.status === 401) {
          return {
            connected: false,
            provider: "google",
            reason: "expired",
            message: "Gmail access has expired. Reconnect Google to continue.",
          };
        }
        if (
          error instanceof GmailRequestError
          && error.status === 403
          && /rate.?limit|quota|daily.?limit/i.test(error.reason ?? "")
        ) {
          return {
            connected: false,
            provider: "google",
            reason: "rate_limited",
            message: "Gmail is temporarily rate limited. Wait and retry.",
          };
        }
        if (error instanceof GmailRequestError && error.status === 403) {
          return {
            connected: false,
            provider: "google",
            reason: "insufficient_scope",
            message: "Gmail needs additional Google permission. Reconnect Google and approve Gmail access.",
          };
        }
        throw error;
      }
    };

    return [
      {
        name: "create_draft",
        description: "Create an email draft without sending it.",
        parameters: CreateDraftParamsSchema,
        execute: run(CreateDraftParamsSchema, (gmail, params) => gmail.createDraft(params)),
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
    ];
  },
});
