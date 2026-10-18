import { ZendeskClient } from "./client.js";
import {
  AddInternalNoteParamsSchema,
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
  description: "Zendesk extension for reading, searching, and triaging tickets, and adding internal notes.",
  systemPrompt: `Use this extension to read, search, and triage Zendesk support tickets and add internal notes.

For ticket lists, use pageSize up to 100 and pageCursor from the prior response. Results are newest first by default; pass sort to override (id, -id, updated_at, -updated_at, status, -status). Ticket searches use offset pagination and optional sort. Group listings use cursor pagination; pass groupId when listing one team's agents.

Only the fields you pass change when updating a ticket. Internal notes are visible to agents only, never to the requester.

Common workflows:
- To find tickets matching criteria, use zendesk_search_tickets with a query like "status:open requester:user@example.com".
- To browse all tickets, use zendesk_list_tickets and follow nextPageCursor across pages.
- To inspect a specific ticket including its conversation, use zendesk_get_ticket — comments are merged into the response.
- To triage, read the ticket first with zendesk_get_ticket, then apply changes with zendesk_update_ticket and record your reasoning with zendesk_add_internal_note.

Notes:
- This extension cannot create or delete tickets, and cannot post public replies to requesters.
- Assignee and group ids are numeric Zendesk ids. Look them up with zendesk_list_groups / zendesk_list_agents; never guess them.
- Ticket ids are numeric.
- In oauth mode the requester's connected Zendesk account is used. If a tool reports not connected, share the connect link it returns; do not guess or supply credentials.`,
  configSchema: ZendeskConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  oauthHiddenFields: ["mode", "subdomain", "email", "apiKey", "timeoutMs"],
  oauthProviders: [zendeskOAuthProvider],
  oauth: (config) =>
    config.merged.mode !== "api_key" ? { provider: "zendesk", scopes: ["read", "tickets:write"] } : undefined,
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
    ];
  },
});
