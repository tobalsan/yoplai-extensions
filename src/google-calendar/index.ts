import type { z } from "zod";
import { defineToolExtension } from "../tool-extension.js";
import { googleOAuthProvider } from "../google-oauth-provider.js";
import { CalendarClient, CalendarRequestError } from "./client.js";
import { CalendarConfigSchema, toolSchemas } from "./models.js";

const messages: Record<string, string> = {
  not_connected: "Google Calendar is not connected. Connect Google Calendar (Just me or Whole team) in the agent's Calendar settings.",
  expired: "Google Calendar access has expired. Reconnect Google Calendar to continue.",
  insufficient_scope: "Calendar permission was not approved. Reconnect Google Calendar and approve Calendar access.",
  wrong_account: "Google Calendar does not match the connected Google account. Reconnect the intended account.",
  rate_limited: "Google Calendar is temporarily rate limited. Wait and retry.",
};
type ToolName = keyof typeof toolSchemas;
type Action = (client: CalendarClient, params: unknown, account: string) => Promise<unknown>;
type Actions = { [K in ToolName]: (client: CalendarClient, params: z.infer<(typeof toolSchemas)[K]>, account: string) => Promise<unknown> };
const actions: Actions = {
  list_calendars: (client, params) => client.list_calendars(params),
  list_events: (client, params) => client.list_events(params),
  get_event: (client, params) => client.get_event(params),
  search_events: (client, params) => client.search_events(params),
  suggest_time: (client, params) => client.suggest_time(params),
  create_event: (client, params, account) => client.create_event(params, account),
  update_event: (client, params) => client.update_event(params),
  delete_event: (client, params) => client.delete_event(params),
  respond_to_event: (client, params, account) => client.respond_to_event(params, account),
};
const readOnly = new Set(["list_calendars", "list_events", "get_event", "search_events", "suggest_time"]);
export default defineToolExtension({
  id: "googleCalendar",
  displayName: "Google Calendar",
  description: "Google Calendar tools using your personal or shared team Google connection.",
  configSchema: CalendarConfigSchema,
  requiredSecrets: [],
  oauthProviders: [googleOAuthProvider],
  oauth: { provider: "google", scopes: ["calendar.events", "calendar.calendarlist.readonly", "calendar.freebusy", "userinfo.email"].map(scope => `https://www.googleapis.com/auth/${scope}`) },
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected ? oauth : undefined;
    const client = connected ? new CalendarClient(connected.accessToken) : undefined;
    const disconnected = (reason: string, message = messages[reason], agentId?: string) => {
      const fallbackUrl = agentId ? `/agents/${encodeURIComponent(agentId)}/extensions/googleCalendar` : "/agents";
      return { connected: false, provider: "google", reason, message, authorizeUrl: (oauth && !oauth.connected ? oauth.authorizeUrl : undefined) ?? fallbackUrl };
    };
    return Object.entries(toolSchemas).map(([name, schema]) => ({
      name,
      description: schema.description ?? name,
      parameters: schema,
      annotations: { readOnlyHint: readOnly.has(name) },
      async execute(value: unknown, context?: { agentId: string }) {
        if (!client || !connected) return disconnected(oauth && !oauth.connected ? oauth.reason : "not_connected", oauth && !oauth.connected ? oauth.message : messages.not_connected, context?.agentId);
        const params = schema.parse(value);
        try {
          const account = await client.account();
          if (connected.account && account.toLowerCase() !== connected.account.toLowerCase()) return disconnected("wrong_account", messages.wrong_account, context?.agentId);
          const result = await (actions[name as ToolName] as Action)(client, params, account);
          return { ...(result as object), account: account || connected.account || null };
        } catch (error) {
          if (error instanceof CalendarRequestError && error.reason !== "request_failed") return disconnected(error.reason, messages[error.reason], context?.agentId);
          throw error;
        }
      },
    }));
  },
});
