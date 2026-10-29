# Google Analytics

Read-only GA4 tools using host-managed Google OAuth. Connections may be personal (**Just me**) or shared (**Whole team**): the requester's personal connection takes precedence over the shared fallback. Extension ID: `googleAnalytics`; source/build directory: `google-analytics`.

## Setup

1. Enable both **Analytics Data API** and **Analytics Admin API** in the Google Cloud project used by the host's Google OAuth client.
2. Add `https://www.googleapis.com/auth/analytics.readonly` alongside `https://www.googleapis.com/auth/userinfo.email` to the OAuth consent configuration. These are the extension's only scopes.
3. Enable `googleAnalytics` for the agent and connect or reconnect in its extension settings, using **Just me** or **Whole team**.
4. Give the connected Google account at least **Viewer** access to the GA4 property. Reconnecting cannot fix missing property access or disabled APIs.

No service account, secrets, write scopes, or GA4 configuration changes are supported. Expired access, missing scopes, wrong accounts and rate limits return actionable refusals with `isError: true`. Property permissions and disabled APIs produce setup errors; requests time out after 30 seconds.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_properties` | Page through accessible account summaries and return properties with their account names. |
| `describe_property` | Before reporting, read the property time zone, currency, configured key-event names/counting methods, and custom dimensions/metrics. |
| `run_report` | Ad-hoc dimensions, metrics, one or two date ranges, ANDed simple dimension/metric filters, ordering and explicit pagination. |
| `compare_periods` | Fetch both periods, normalize/join pages, compute changes and API totals, optionally break down channels and identifiable AI referrals. |

Pass a bare numeric property ID or `properties/<id>`. Each tool has a success output schema and `readOnlyHint: true`.

### Comparison behavior

Defaults: `landingPage`, the 28 days ending **today minus 3** in the property's time zone, versus the preceding 28 days. Supplying only `current` derives an equally long previous period immediately before it. Real `YYYY-MM-DD` calendar dates are required; reversed dates are rejected. Unequal periods are accepted with a not-like-for-like warning; dates ending within two days of today or in the future warn about processing delay/incomplete days.

- `landingPage`: sessions that started on the page and their key events (attribution).
- `pagePath`: traffic involving the page; additionally returns `screenPageViews`.
- Metrics include sessions, engaged sessions, engagement rate, total key events and requested known `keyEvents` names. Each has `current`, `previous`, `delta`, `percentDelta` (null when previous is zero). Engagement rate is recomputed as engaged sessions / sessions after merging paths.
- Unknown named key events warn and are omitted. With no configured key events, traffic still works and says **conversion data unavailable**; key-event values are null, not measured zeros. The tool never decides what counts as a lead.
- `hostName`, `country` (full name, e.g. `United States`), `pagePathRegex` (partial regex on the chosen dimension), `channelGroup`, and `pagePaths` are ANDed. Host is a filter, never a report dimension: sessions can span hosts.
- `minSessions` uses the larger period. `sortBy`: `sessionsDelta` (default), `keyEventsDelta`, `sessions`, `keyEvents`. Deltas default ascending (worst first); current values default descending. `order` overrides this; null sort values go last. `limit` defaults to 50, or the normalized unique page-list size, and is capped at 500.
- Fetches 25,000 rows per page, up to 100,000 per series. A channel breakdown adds another series for each period. `meta.rowsFetched` includes all fetched series; `truncated` warns that new/lost classifications may be incomplete.
- `totals.current` and `totals.previous` use GA4's `TOTAL` aggregation, independent of returned-row sorting/floors/limits. Never add `pagePath` rows to obtain site sessions.
- `meta` records periods, filters, property time zone, fetched/matched/returned counts, missing pages, key-event availability, sampling metadata, thresholding and other-row data loss. Quality flags combine every response, including channel series; warnings flag thresholding, `(other)` rows, processing delay and truncation.

### Data rules and GSC joins

GA4 dates use the **property time zone**; GSC uses **Pacific time** (`America/Los_Angeles`). `meta.timezoneNote` states this; no silent conversion occurs. GA4 sessions and GSC clicks are different measures. Landing-page key events are not page key events. Never sum `pagePath` rows to get site sessions.

A normalized `pagePath` drops query strings, fragments and trailing slashes (except `/`); path case is preserved. Rows collapsing onto that key are merged. A single `hostName` filter also supplies `pageUrl = https://<hostName><pagePath>`; otherwise `pageUrl` is null.

For the Monday lookup, call GSC `compare_periods` first, pass its page URLs as GA4 `pagePaths` with the same host filter, then join on `pagePath` (the normalized path part of the GSC URL), or `pageUrl` when the host matches. `pagePaths` accepts 1–500 paths or HTTP(S) URLs, drops queries, deduplicates, and sends a case-sensitive `inListFilter` with both trailing-slash forms (root once). Google's v1beta reference documents no maximum number of values; this extension sends at most 1,000 variants in one list.

Requested paths without data in either period return zero traffic and appear in `meta.pagePathsWithoutData`; their `status` is `both` and the missing-data list distinguishes them from measured pages. Floors and an explicitly smaller `limit` can still remove rows. GSC retains query strings while GA4 page dimensions do not: a query-bearing GSC row has no exact GA4 counterpart. Passing it in `pagePaths` looks up the base page; the caller must decide whether to leave that GSC row unmatched or merge it into the base page.

### Identifiable AI referrals

With `breakdown: "channel"`, `channels` groups sessions and key events by GA4 `sessionDefaultChannelGroup`; `aiReferral` is **identifiable AI referrals**, a subset cutting across those channels, not a GA4 channel and not additive with them. Sources are lowercased, leading `www.` is stripped, and listed hosts or their subdomains match.

Default hosts: `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, `claude.ai`.

Override with the extension's merged config; the list **replaces** defaults (an empty list disables matching):

```yaml
extensions:
  googleAnalytics:
    enabled: true
    aiReferralHosts:
      - chatgpt.com
      - perplexity.ai
      - example.ai
```

AI-assistant visits with stripped referrers land in Direct and are invisible to this classifier. Citations are not visits; this bucket only measures identifiable referral sessions.

### Raw reports

`run_report` accepts `dimensions`, `metrics`, `dateRanges` (1–2), `dimensionFilters`, `metricFilters`, `orderBys`, `limit` (default 1,000; max 25,000), `offset` (default 0). Dimension filters use `field`, `match` (`exact`, `contains`, `beginsWith`, `endsWith`, `partialRegex`, `fullRegex`, `in`), `value` (or `values` for `in`), optional `not` and `caseSensitive`. Metric filters use `field`, `operation` (`eq`, `lt`, `lte`, `gt`, `gte`), numeric `value`. Order entries use `field`, `desc`.

Rows contain dimension-name/string and metric-name/number dictionaries. With two date ranges, GA4's additional `dateRange` dimension is preserved. Continue with `nextOffset` until null; `rowCount` describes all matching rows. `meta` supplies time zone, currency, sampling, thresholding, other-row warnings and recent-date warnings.

## Worked examples

Use the actual property ID and configured event names discovered with `list_properties` and `describe_property`. Names and hosts below are placeholders.

### AirOps Traffic column

```json
{
  "property": "properties/123456789",
  "dimension": "landingPage",
  "hostName": "www.example.com",
  "country": "United States",
  "pagePathRegex": "^/features/"
}
```

Call `googleAnalytics.compare_periods` for sessions and their changes; use `pagePath` with `screenPageViews` when the question concerns views rather than landing attribution.

### Captive-portal traffic and key events

```json
{
  "property": "123456789",
  "current": { "startDate": "2026-09-29", "endDate": "2026-10-26" },
  "previous": { "startDate": "2026-09-01", "endDate": "2026-09-28" },
  "hostName": "www.example.com",
  "pagePaths": ["/features/cloud-captive-portal"],
  "breakdown": "channel",
  "keyEvents": ["contact_request", "demo_request"]
}
```

Only the team can agree whether those configured events represent its desired outcomes. An unconfigured name warns and is omitted; no configured key events means conversion data unavailable.

### Monday refresh lookup

First call `googleSearchConsole.compare_periods`:

```json
{
  "siteUrl": "https://www.example.com/",
  "dimension": "page",
  "sortBy": "clicksDelta",
  "order": "asc",
  "limit": 50
}
```

Then pass those returned `rows[].page` URLs and the same periods to `googleAnalytics.compare_periods`:

```json
{
  "property": "123456789",
  "hostName": "www.example.com",
  "pagePaths": ["https://www.example.com/features/cloud-captive-portal", "https://www.example.com/blog/example/"],
  "minSessions": 10,
  "sortBy": "sessionsDelta"
}
```

Use the GSC result's `meta.current` and `meta.previous` as `current` and `previous` for a calendar-aligned lookup; the defaults can differ across property time zones. Join by normalized `pagePath`, keeping GSC decline alongside GA4 sessions and agreed key events.

## API references

- [Admin API key-events list](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.keyEvents/list)
- [Data API runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport), [TOTAL aggregation](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricAggregation)
- [Response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData), [filter expressions](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression)

Validation uses injected reports/clock and mocked HTTP through tool execution. A live authorized property check belongs to the operator; automated tests never call Google.
