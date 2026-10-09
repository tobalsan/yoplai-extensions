import { ZendeskClient } from "./client.js";
import {
  GetTicketParamsSchema,
  ListTicketsParamsSchema,
  SearchTicketsParamsSchema,
  ZendeskConfigSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";
import type { ResolvedOAuth } from "../tool-extension.js";

export { ZendeskConfigSchema };

/** Documented not-connected signal — never a raw 401. */
function notConnected(oauth: ResolvedOAuth | undefined) {
  return {
    connected: false,
    provider: "zendesk",
    reason: oauth && !oauth.connected ? oauth.reason : "not_connected",
    message:
      oauth && !oauth.connected
        ? oauth.message
        : "Zendesk is not connected. Connect a Zendesk account in the agent's Zendesk settings.",
    authorizeUrl:
      oauth && !oauth.connected && "authorizeUrl" in oauth ? oauth.authorizeUrl : undefined,
  };
}

export default defineToolExtension({
  id: "zendesk",
  displayName: "Zendesk",
  description: "Read-only Zendesk extension for tickets, comments, and ticket search.",
  systemPrompt: `Use this extension for read-only access to Zendesk support tickets.

Available tools:
- zendesk_list_tickets: list tickets with cursor-based pagination (pageSize up to 100, pageCursor from prior response). Returns newest tickets first by default; pass sort to override (id, -id, updated_at, -updated_at, status, -status)
- zendesk_search_tickets: search tickets by Zendesk search query (e.g. "status:open priority:high"), with offset pagination and optional sort
- zendesk_get_ticket: fetch a single ticket by id, with comments included

Common workflows:
- To find tickets matching criteria, use zendesk_search_tickets with a query like "status:open requester:user@example.com".
- To browse all tickets, use zendesk_list_tickets and follow nextPageCursor across pages.
- To inspect a specific ticket including its conversation, use zendesk_get_ticket — comments are merged into the response.

Notes:
- This extension is read-only. It cannot create, update, or delete tickets.
- Ticket ids are numeric.
- In oauth mode the requester's connected Zendesk account is used. If a tool reports not connected, share the connect link it returns; do not guess or supply credentials.`,
  configSchema: ZendeskConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  oauthHiddenFields: ["mode", "subdomain", "email", "apiKey", "timeoutMs"],
  oauth: (config) =>
    config.merged.mode !== "api_key" ? { provider: "zendesk", scopes: ["read"] } : undefined,
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
        execute: async (params) => (client ? client.listTickets(params) : notConnected(oauth)),
      },
      {
        name: "search_tickets",
        description: "Search tickets using Zendesk search syntax.",
        parameters: SearchTicketsParamsSchema,
        execute: async (params) => (client ? client.searchTickets(params) : notConnected(oauth)),
      },
      {
        name: "get_ticket",
        description: "Get a ticket by id, with comments included.",
        parameters: GetTicketParamsSchema,
        execute: async (params) => (client ? client.getTicket(params) : notConnected(oauth)),
      },
    ];
  },
});
