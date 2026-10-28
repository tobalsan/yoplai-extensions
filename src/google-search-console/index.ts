import { defineToolExtension, notConnected } from "../tool-extension.js";
import { googleOAuthProvider } from "../google-oauth-provider.js";
import { SearchConsoleClient, SearchConsoleRequestError } from "./client.js";
import { ConfigSchema, toolSchemas, outputSchemas } from "./models.js";
import { comparePeriods } from "./comparison.js";

const NOT_CONNECTED = "Google Search Console is not connected. Connect Google Search Console (Just me or Whole team) in the agent's Search Console settings.";
const messages: Record<string, string> = {
  expired: "Google Search Console access has expired. Reconnect Google Search Console to continue.",
  insufficient_scope: "Search Console permission was not approved. Reconnect Google Search Console and approve Search Console access.",
  wrong_account: "Google Search Console does not match the connected Google account. Reconnect the intended account.",
  rate_limited: "Google Search Console is temporarily rate limited. Wait and retry.",
};
export default defineToolExtension({
  id: "googleSearchConsole",
  displayName: "Google Search Console",
  description: "Read-only Search Console analytics, indexing and sitemap tools using your personal or shared team Google connection.",
  configSchema: ConfigSchema,
  requiredSecrets: [],
  oauthProviders: [googleOAuthProvider],
  oauth: { provider: "google", scopes: ["webmasters.readonly", "userinfo.email"].map(scope => `https://www.googleapis.com/auth/${scope}`) },
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected ? oauth : undefined;
    return Object.entries(toolSchemas).map(([name, schema]) => ({
      name, description: schema.description ?? name, parameters: schema,
      outputSchema: outputSchemas[name as keyof typeof outputSchemas],
      annotations: { readOnlyHint: true },
      async execute(value: unknown, context?: { agentId?: string }) {
        if (!connected) return notConnected("google", NOT_CONNECTED, oauth);
        schema.parse(value);
        const client = new SearchConsoleClient(connected.accessToken);
        const refusal = (reason: string) => ({ isError: true, connected: false, provider: "google", reason, message: messages[reason], authorizeUrl: context?.agentId ? `/agents/${encodeURIComponent(context.agentId)}/extensions/googleSearchConsole` : "/agents" });
        try {
          const account = await client.account();
          if (connected.account && account.toLowerCase() !== connected.account.toLowerCase()) return refusal("wrong_account");
          let result: object;
          if (name === "compare_periods") result = await comparePeriods(toolSchemas.compare_periods.parse(value), query => client.searchAnalytics(query));
          else if (name === "list_sitemaps") result = await client.listSitemaps(toolSchemas.list_sitemaps.parse(value));
          else if (name === "inspect_url") result = await client.inspectUrl(toolSchemas.inspect_url.parse(value));
          else if (name === "search_analytics") {
            const params = toolSchemas.search_analytics.parse(value);
            const page = await client.searchAnalytics(params);
            const truncated = page.rows.length === params.rowLimit;
            result = { ...page, truncated, nextStartRow: truncated ? params.startRow + params.rowLimit : null };
          } else result = await client.listSites();
          return { ...result, account: account || connected.account || null };
        } catch (error) {
          if (error instanceof SearchConsoleRequestError && error.reason !== "request_failed") return refusal(error.reason);
          throw error;
        }
      },
    }));
  },
});
