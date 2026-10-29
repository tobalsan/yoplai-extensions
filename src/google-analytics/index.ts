import { defineToolExtension, notConnected } from "../tool-extension.js";
import { googleOAuthProvider } from "../google-oauth-provider.js";
import { GoogleAnalyticsClient, GoogleAnalyticsRequestError } from "./client.js";
import { ConfigSchema, toolSchemas, outputSchemas } from "./models.js";
import { comparePeriods, type ReportRequest } from "./comparison.js";

const NOT_CONNECTED = "Google Analytics is not connected. Connect Google Analytics (Just me or Whole team) in the agent's Google Analytics settings.";
const messages: Record<string, string> = {
  expired: "Google Analytics access has expired. Reconnect Google Analytics to continue.",
  insufficient_scope: "Google Analytics permission was not approved. Reconnect Google Analytics and approve Google Analytics access.",
  wrong_account: "Google Analytics does not match the connected Google account. Reconnect the intended account.",
  rate_limited: "Google Analytics is temporarily rate limited. Wait and retry.",
};
export default defineToolExtension({
  id: "googleAnalytics", displayName: "Google Analytics",
  description: "Read-only GA4 analytics using your personal or shared team Google connection.",
  configSchema: ConfigSchema, requiredSecrets: [], oauthProviders: [googleOAuthProvider],
  oauth: { provider: "google", scopes: ["analytics.readonly", "userinfo.email"].map(scope => `https://www.googleapis.com/auth/${scope}`) },
  createTools(config) {
    const oauth = config.oauth;
    const connected = oauth?.connected ? oauth : undefined;
    return Object.entries(toolSchemas).map(([name, schema]) => ({
      name, description: schema.description ?? name, parameters: schema,
      outputSchema: outputSchemas[name as keyof typeof outputSchemas], annotations: { readOnlyHint: true },
      async execute(value: unknown, context?: { agentId?: string }) {
        if (!connected) return notConnected("google", NOT_CONNECTED, oauth);
        schema.parse(value);
        const client = new GoogleAnalyticsClient(connected.accessToken);
        const refusal = (reason: string) => ({ isError: true, connected: false, provider: "google", reason, message: messages[reason], authorizeUrl: context?.agentId ? `/agents/${encodeURIComponent(context.agentId)}/extensions/googleAnalytics` : "/agents" });
        try {
          const account = await client.account();
          if (connected.account && account.toLowerCase() !== connected.account.toLowerCase()) return refusal("wrong_account");
          let result: object;
          if (name === "compare_periods") {
            const params = toolSchemas.compare_periods.parse(value);
            const property = await client.getProperty(params.property);
            result = await comparePeriods({ ...params, timeZone: property.timeZone, aiReferralHosts: ConfigSchema.parse(config.merged).aiReferralHosts }, query => client.runReport(params.property, query), () => client.listKeyEvents(params.property));
          } else if (name === "describe_property") {
            const { property } = toolSchemas.describe_property.parse(value);
            const settings = await client.getProperty(property);
            const keyEvents = await client.listKeyEvents(property);
            const metadata = await client.getMetadata(property);
            result = { property, ...settings, keyEvents, ...metadata, warnings: keyEvents.length ? [] : ["No key events are configured: conversion data unavailable"] };
          } else if (name === "run_report") {
            const params = toolSchemas.run_report.parse(value);
            const matches = { exact: "EXACT", contains: "CONTAINS", beginsWith: "BEGINS_WITH", endsWith: "ENDS_WITH", partialRegex: "PARTIAL_REGEXP", fullRegex: "FULL_REGEXP" };
            const operations = { eq: "EQUAL", lt: "LESS_THAN", lte: "LESS_THAN_OR_EQUAL", gt: "GREATER_THAN", gte: "GREATER_THAN_OR_EQUAL" };
            const body: ReportRequest = { dimensions: params.dimensions.map(name => ({ name })), metrics: params.metrics.map(name => ({ name })), dateRanges: params.dateRanges, limit: params.limit, offset: params.offset, orderBys: params.orderBys.map(order => ({ ...(params.metrics.includes(order.field) ? { metric: { metricName: order.field } } : { dimension: { dimensionName: order.field } }), desc: order.desc })) };
            if (params.dimensionFilters.length) body.dimensionFilter = { andGroup: { expressions: params.dimensionFilters.map(filter => {
              const expression = { filter: { fieldName: filter.field, ...(filter.match === "in" ? { inListFilter: { values: filter.values, caseSensitive: filter.caseSensitive ?? false } } : { stringFilter: { matchType: matches[filter.match], value: filter.value, caseSensitive: filter.caseSensitive ?? false } }) } };
              return filter.not ? { notExpression: expression } : expression;
            }) } };
            if (params.metricFilters.length) body.metricFilter = { andGroup: { expressions: params.metricFilters.map(filter => ({ filter: { fieldName: filter.field, numericFilter: { operation: operations[filter.operation], value: { doubleValue: filter.value } } } })) } };
            const report = await client.runReport(params.property, body);
            const rows = (report.rows ?? []).map(row => ({ dimensions: Object.fromEntries((report.dimensionHeaders ?? []).map((header, index) => [header.name, row.dimensionValues?.[index]?.value ?? ""])), metrics: Object.fromEntries((report.metricHeaders ?? []).map((header, index) => [header.name, Number(row.metricValues?.[index]?.value ?? 0)])) }));
            const metadata = report.metadata;
            const warnings: string[] = [];
            if (metadata?.timeZone) {
              const today = new Intl.DateTimeFormat("en-CA", { timeZone: metadata.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
              const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
              if (params.dateRanges.some(period => period.endDate >= recent)) warnings.push("Requested periods include incomplete days or GA4 processing delay (about 24 to 48 hours).");
            }
            if (metadata?.subjectToThresholding) warnings.push("GA4 data is subject to thresholding.");
            if (metadata?.dataLossFromOtherRow || rows.some(row => Object.values(row.dimensions).includes("(other)"))) warnings.push("GA4 (other) rows or data loss from other rows may hide detail.");
            const rowCount = report.rowCount ?? rows.length;
            result = { rows, rowCount, nextOffset: params.offset + rows.length < rowCount ? params.offset + rows.length : null, meta: { timezone: metadata?.timeZone ?? null, currency: metadata?.currencyCode ?? null, subjectToThresholding: metadata?.subjectToThresholding ?? false, dataLossFromOtherRow: metadata?.dataLossFromOtherRow ?? false, samplingMetadatas: metadata?.samplingMetadatas ?? [], warnings } };
          } else {
            const summaries = await client.accountSummaries();
            result = { properties: summaries.flatMap(summary => (summary.propertySummaries ?? []).map(property => ({ ...property, account: summary.account, accountDisplayName: summary.displayName }))) };
          }
          return { ...result, account: account || connected.account || null };
        } catch (error) {
          if (error instanceof GoogleAnalyticsRequestError && error.reason !== "request_failed") return refusal(error.reason);
          throw error;
        }
      },
    }));
  },
});
