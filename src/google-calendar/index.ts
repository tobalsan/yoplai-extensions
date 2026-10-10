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
    const disconnected = (reason: string, message = messages[reason], agentId?: string) => ({ connected: false, provider: "google", reason, message, authorizeUrl: oauth && !oauth.connected ? oauth.authorizeUrl ?? (agentId ? `/agents/${encodeURIComponent(agentId)}/extensions/googleCalendar` : "/agents") : (agentId ? `/agents/${encodeURIComponent(agentId)}/extensions/googleCalendar` : "/agents") });
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
          let result: unknown;
          switch (name) {
            case "list_calendars": result = await client.list_calendars(toolSchemas.list_calendars.parse(params)); break;
            case "list_events": result = await client.list_events(toolSchemas.list_events.parse(params)); break;
            case "get_event": result = await client.get_event(toolSchemas.get_event.parse(params)); break;
            case "search_events": result = await client.search_events(toolSchemas.search_events.parse(params)); break;
            case "suggest_time": result = await client.suggest_time(toolSchemas.suggest_time.parse(params)); break;
            case "create_event": result = await client.create_event(toolSchemas.create_event.parse(params), account); break;
            case "update_event": result = await client.update_event(toolSchemas.update_event.parse(params)); break;
            case "delete_event": result = await client.delete_event(toolSchemas.delete_event.parse(params)); break;
            case "respond_to_event": result = await client.respond_to_event(toolSchemas.respond_to_event.parse(params), account); break;
            default: throw new Error("Unknown Calendar tool");
          }
          return { ...(result as object), account: account || connected.account || null };
        } catch (error) {
          if (error instanceof CalendarRequestError && error.reason !== "request_failed") return disconnected(error.reason, messages[error.reason], context?.agentId);
          throw error;
        }
      },
    }));
  },
});
