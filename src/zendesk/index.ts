import { ZendeskClient } from "./client.js";
import path from "node:path";
import { readConversationFile } from "../conversation-files.js";
import { ZendeskValidationError } from "./errors.js";
import {
  AddInternalNoteParamsSchema,
  ArticleResultSchema,
  UploadArticleAttachmentParamsSchema,
  UploadArticleAttachmentResultSchema,
  CreateArticleParamsSchema,
  ListHelpCenterSectionsParamsSchema,
  ListHelpCenterSectionsResultSchema,
  ListArticlesParamsSchema,
  ListArticlesResultSchema,
  UpdateArticleParamsSchema,
  ArchiveArticleParamsSchema,
  ArchiveArticleResultSchema,
  GetTicketParamsSchema,
  GetTicketResultSchema,
  SearchTicketsResultSchema,
  ListAgentsParamsSchema,
  ListGroupsParamsSchema,
  ListTicketsParamsSchema,
  SearchTicketsParamsSchema,
  UpdateTicketParamsSchema,
  ZendeskConfigSchema,
} from "./models.js";
import { defineToolExtension, notConnected } from "../tool-extension.js";
import type { OAuthProviderDescriptor } from "../tool-extension.js";

export { ZendeskConfigSchema };

/** Documented not-connected signal — never a raw 401. */
const NOT_CONNECTED_MESSAGE =
  "Zendesk is not connected. Connect a Zendesk account in the agent's Zendesk settings.";

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

/** Zendesk descriptor. URLs are per-tenant: `{subdomain}` comes from oauth.providers.zendesk.subdomain. */
const zendeskOAuthProvider: OAuthProviderDescriptor = {
  id: "zendesk",
  displayName: "Zendesk",
  authorizeUrl: "https://{subdomain}.zendesk.com/oauth/authorizations/new",
  tokenUrl: "https://{subdomain}.zendesk.com/oauth/tokens",
  userInfoUrl: "https://{subdomain}.zendesk.com/api/v2/users/me.json",
  apiBaseUrl: "https://{subdomain}.zendesk.com",
  defaultScopes: ["read"],
  extractAccount(userInfo) {
    const email = (userInfo as { user?: { email?: unknown } } | null)?.user?.email;
    return typeof email === "string" ? email : undefined;
  },
};

export default defineToolExtension({
  id: "zendesk",
  displayName: "Zendesk",
  description: "Zendesk extension for reading, searching, and triaging tickets, adding internal notes, and creating and revising Help Center articles with image attachments.",
  systemPrompt: `Use this extension to read, search, and triage Zendesk support tickets and add internal notes.

For ticket lists, use pageSize up to 100 and pageCursor from the prior response. Results are newest first by default; pass sort to override (id, -id, updated_at, -updated_at, status, -status). Ticket searches use offset pagination and optional sort. Group listings use cursor pagination; pass groupId when listing one team's agents.

Only the fields you pass change when updating a ticket. Internal notes are visible to agents only, never to the requester.

Common workflows:
- To find tickets matching criteria, use zendesk_search_tickets with a query like "status:open requester:user@example.com".
- To browse all tickets, use zendesk_list_tickets and follow nextPageCursor across pages.
- To inspect a specific ticket including its conversation, use zendesk_get_ticket — comments are merged into the response.
- To triage, read the ticket first with zendesk_get_ticket, then apply changes with zendesk_update_ticket and record your reasoning with zendesk_add_internal_note.

Help Center workflow:
- Use zendesk_list_help_center_sections to choose a section id and its source locale, then zendesk_list_articles for that section to copy permissionGroupId and userSegmentId. Never guess these ids; omit userSegmentId for public visibility.
- Create an article with zendesk_create_article as a draft by default, using the section's source locale and an HTML body. Set notifySubscribers: false to avoid notifying subscribers. Review the draft, then revise with zendesk_update_article; publish only on explicit request by setting draft: false. Publishing requires the connected user's rights in the permission group.
- For images, create the draft first with zendesk_create_article, then upload each image with zendesk_upload_article_attachment from the current conversation folder (PNG, JPEG, WebP or GIF, up to 5 MB each), then put each returned imgSnippet in the body with zendesk_update_article. Inline images are the default; set inline: false for a plain attachment.
- If the target section has no articles, list the other sections of the same category with \`zendesk_list_help_center_sections\`. Copy the ids from an article in one of these sections. Never omit \`permissionGroupId\`.
- If the articles in the section use more than one permission group, use the group that most articles use. If two groups have the same count, show the user one article title for each group and ask which one to use.
- Archive only draft articles, and ask the user before you archive one. Archived articles can be restored in Zendesk Guide.
- Existing OAuth connections must reconnect to grant the Help Center scopes. If a tool requests reconnection, share its connect link.

Notes:
- Tickets cannot be created or deleted, and public replies to requesters are not supported. Help Center articles can be created, revised, and archived (drafts only), but not permanently deleted.
- Assignee and group ids are numeric Zendesk ids. Look them up with zendesk_list_groups / zendesk_list_agents; never guess them.
- Ticket ids are numeric.
- In oauth mode the requester's connected Zendesk account is used. If a tool reports not connected, share the connect link it returns; do not guess or supply credentials.`,
  configSchema: ZendeskConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  oauthHiddenFields: ["mode", "subdomain", "email", "apiKey", "timeoutMs"],
  oauthProviders: [zendeskOAuthProvider],
  oauth: (config) =>
    config.merged.mode !== "api_key" ? { provider: "zendesk", scopes: ["read", "tickets:write", "hc:read", "hc:write"] } : undefined,
  createTools(config) {
    const resolved = ZendeskConfigSchema.parse(config.merged);
    const oauth = config.oauth;
    // OAuth mode builds a bearer client per call once connected; api_key mode builds it up front.
    const client = (() => {
      if (resolved.mode === "oauth") {
        return oauth?.connected === true && oauth.apiBaseUrl
          ? new ZendeskClient({ accessToken: oauth.accessToken, baseUrl: oauth.apiBaseUrl, timeoutMs: resolved.timeoutMs })
          : undefined;
      }
      return new ZendeskClient({
        subdomain: resolved.subdomain!,
        email: resolved.email!,
        apiKey: resolved.apiKey!,
        timeoutMs: resolved.timeoutMs,
      });
    })();

    return [
      {
        name: "list_tickets",
        description: "List tickets with cursor-based pagination. Returns newest tickets first by default.",
        parameters: ListTicketsParamsSchema,
        execute: async (params) => (client ? client.listTickets(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "search_tickets",
        description: "Search tickets using Zendesk search syntax.",
        parameters: SearchTicketsParamsSchema,
        outputSchema: SearchTicketsResultSchema,
        execute: async (params) => (client ? client.searchTickets(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "get_ticket",
        description: "Get a ticket by id, with comments included.",
        parameters: GetTicketParamsSchema,
        outputSchema: GetTicketResultSchema,
        execute: async (params) => (client ? client.getTicket(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "update_ticket",
        description:
          "Triage a ticket: set status, priority, type, assignee, group, and add/remove tags. Only passed fields change.",
        parameters: UpdateTicketParamsSchema,
        execute: async (params) => (client ? client.updateTicket(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "add_internal_note",
        description: "Add a private internal note to a ticket (agents only, not visible to the requester).",
        parameters: AddInternalNoteParamsSchema,
        execute: async (params) => (client ? client.addInternalNote(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "list_groups",
        description: "List support groups (teams) with their ids, for routing tickets.",
        parameters: ListGroupsParamsSchema,
        execute: async (params) => (client ? client.listGroups(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "list_agents",
        description: "List agents and admins (assignable users) with their ids; pass groupId to list one team's members.",
        parameters: ListAgentsParamsSchema,
        execute: async (params) => (client ? client.listAgents(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "list_help_center_sections",
        description: "List Help Center sections with category names and source locales. Optionally filter by categoryId; follow nextPageCursor across pages.",
        parameters: ListHelpCenterSectionsParamsSchema,
        outputSchema: ListHelpCenterSectionsResultSchema,
        execute: async (params) => (client ? client.listHelpCenterSections(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "list_articles",
        description: "List articles in a Help Center section without bodies. Copy permissionGroupId and userSegmentId from these articles when creating an article; never guess them.",
        parameters: ListArticlesParamsSchema,
        outputSchema: ListArticlesResultSchema,
        execute: async (params) => (client ? client.listArticles(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "create_article",
        description: "Create a Help Center article from a title and HTML body, as a draft by default. Use the section's source locale from zendesk_list_help_center_sections. Always copy permissionGroupId and visibility from existing articles. Publish only on explicit request and with publishing rights.",
        parameters: CreateArticleParamsSchema,
        outputSchema: ArticleResultSchema,
        execute: async (params) => (client ? client.createArticle(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "update_article",
        description: "Revise a Help Center article after review: change title, HTML body, draft state, or labels. Only passed fields change. Publish only on explicit request; publishing requires rights in the permission group. Reports partial success if labels fail after the translation changes.",
        parameters: UpdateArticleParamsSchema,
        outputSchema: ArticleResultSchema,
        execute: async (params) => (client ? client.updateArticle(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
      {
        name: "upload_article_attachment",
        description: "Create a draft with zendesk_create_article, upload PNG, JPEG, WebP or GIF images from the conversation folder with this tool, then insert the returned imgSnippet into the body with zendesk_update_article.",
        parameters: UploadArticleAttachmentParamsSchema,
        outputSchema: UploadArticleAttachmentResultSchema,
        execute: async (input, context) => {
          if (!client) return notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth);
          const params = UploadArticleAttachmentParamsSchema.parse(input);
          const mimeType = IMAGE_MIME[path.extname(params.path).toLowerCase()];
          if (!mimeType) throw new ZendeskValidationError("Only PNG, JPEG, WebP and GIF images are supported.");
          const signal = context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(resolved.timeoutMs)]) : AbortSignal.timeout(resolved.timeoutMs);
          const bytes = await readConversationFile(params.path, context, signal, MAX_ATTACHMENT_BYTES).catch((error: unknown) => {
            if (error instanceof Error && "status" in error && error.status === 413) throw new ZendeskValidationError("Image exceeds the 5 MB (5242880 bytes) attachment limit.", { status: 413 });
            throw error;
          });
          const result = await client.uploadArticleAttachment({ articleId: params.articleId, inline: params.inline, fileName: path.basename(params.path), mimeType, bytes }, signal);
          return { ...result, imgSnippet: `<img src="${escapeHtml(result.attachment.contentUrl)}" alt="${escapeHtml(result.attachment.fileName)}">` };
        },
      },
      {
        name: "archive_article",
        description: "Archive a draft Help Center article by id. Only drafts can be archived; published articles are refused. Ask the user before you archive. Archived articles can be restored in Zendesk Guide.",
        parameters: ArchiveArticleParamsSchema,
        outputSchema: ArchiveArticleResultSchema,
        execute: async (params) => (client ? client.archiveArticle(params) : notConnected("zendesk", NOT_CONNECTED_MESSAGE, oauth)),
      },
    ];
  },
});
