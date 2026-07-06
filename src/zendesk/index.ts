import { ZendeskClient } from "./client.js";
import {
  GetTicketParamsSchema,
  ListTicketsParamsSchema,
  SearchTicketsParamsSchema,
  ZendeskConfigSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export { ZendeskConfigSchema };

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
- Ticket ids are numeric.`,
  configSchema: ZendeskConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const resolved = ZendeskConfigSchema.parse(config.merged);
    const client = new ZendeskClient(resolved);

    return [
      {
        name: "list_tickets",
        description: "List tickets with cursor-based pagination. Returns newest tickets first by default.",
        parameters: ListTicketsParamsSchema,
        execute: (params) => client.listTickets(params),
      },
      {
        name: "search_tickets",
        description: "Search tickets using Zendesk search syntax.",
        parameters: SearchTicketsParamsSchema,
        execute: (params) => client.searchTickets(params),
      },
      {
        name: "get_ticket",
        description: "Get a ticket by id, with comments included.",
        parameters: GetTicketParamsSchema,
        execute: (params) => client.getTicket(params),
      },
    ];
  },
});
