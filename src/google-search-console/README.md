# Google Search Console extension

Read-only Search Console analytics, indexing status and sitemap health via
host-managed Google OAuth. Enable `googleSearchConsole: {}` under an agent's
`extensions`, then connect from its Google Search Console settings using
**Just me** or **Whole team**. Only admins configure the team connection; the
host uses the requester's personal connection first, then the team's connection.
Gmail, Drive, Calendar and Search Console share the host's Google provider.

## Google Cloud setup

Reuse the host's `oauth.providers.google` configuration. In that OAuth client's
Google Cloud project:

1. Enable **Google Search Console API**.
2. Add `https://www.googleapis.com/auth/webmasters.readonly` to the OAuth
   consent screen's scopes, alongside `https://www.googleapis.com/auth/userinfo.email`.
3. Reconnect Google and approve Search Console access when adding these
   permissions to an existing connection.

These are the extension's only two OAuth scopes. The connected Google account
must also be a user on the Search Console property; granting an OAuth scope
does not grant property access. Use `list_sites` to discover accessible
properties and their permission levels. No credentials belong in the extension
configuration; the extension stores no tokens or analytics data.

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/google-search-console" "$YOPLAI_HOME/extensions/google-search-console"
```

Set `YOPLAI_HOME` to your host's configuration directory before installing.

## Tools

Names mount with the `googleSearchConsole_` prefix. All tools declare
`readOnlyHint: true` and a success `outputSchema`; every successful result
includes `account`.

| Name | Behavior |
| --- | --- |
| `list_sites` | List accessible URL-prefix and `sc-domain:` properties with permission levels |
| `search_analytics` | Query a date range with dimensions, ANDed filters, search type, aggregation and paging |
| `compare_periods` | Fetch two periods and compute joined metrics, changes, status, folders and optional top queries |
| `inspect_url` | Read indexing verdict, coverage, robots.txt/indexing/fetch states, last crawl, canonicals, crawled-as and referring sitemaps |
| `list_sitemaps` | Read sitemap paths/types, submitted/downloaded dates, pending flags, errors and warnings |

`siteUrl` is the exact property identifier, such as `https://example.com/` or
`sc-domain:example.com`; the extension never reconciles different properties.
`inspect_url` requires a URL belonging to the property and has a small daily
quota per property. `list_sitemaps` optionally filters by `sitemapIndex`.

`search_analytics` accepts `startDate`, `endDate`, dimensions (`page`, `query`,
`country`, `device`, `date`, `searchAppearance`), and page/query/country/device
filters. Operators are `equals`, `notEquals`, `contains`, `notContains`,
`includingRegex` and `excludingRegex`; all filters are ANDed in one group.
`type` defaults to `web` and also accepts `image`, `video`, `news`, `discover`
and `googleNews`. `aggregationType` accepts `auto`, `byPage` and `byProperty`;
Google rejects incompatible combinations. `dataState` defaults to `final`;
`all` includes recent incomplete data. `rowLimit` defaults to 1,000 (maximum
25,000) and `startRow` defaults to zero. When a full page is returned,
`truncated: true` and `nextStartRow` indicate that more rows may exist; a short
page returns `false` and `null`.

## Comparison behavior

With no dates, `compare_periods` uses 28 inclusive days ending three days before
today in `America/Los_Angeles`, compared with the immediately preceding 28
days. Supplying `current` defaults `previous` to an equally long period ending
the day before it starts. Reversed ranges are rejected; unequal supplied
period lengths return data with a warning that deltas are not like-for-like.
Dates reaching beyond the three-day completeness lag produce a warning.

`dimension` is `page` by default, or `query` or `page+query`.
`minImpressions` filters on the larger of current and previous impressions.
`sortBy` defaults to `clicksDelta`; `impressionsDelta`, `ctrDelta`,
`positionDelta` and current `clicks` are also supported. Default order is
ascending for clicks/impressions/CTR deltas and descending for position delta
and clicks. Explicit `order` overrides it; null sort values always go last.
`limit` defaults to 50, with a maximum of 500.

Each row includes both periods' clicks, impressions, CTR and position, absolute
and percent changes, and `new`, `lost` or `both` status. Changes are current
minus previous: a positive position delta means a worse numeric position.
Percent changes are null when the previous value is zero; position changes are
null when either period has no position. Missing periods have zero clicks,
impressions and CTR, and null position. `folder` is the first URL path segment,
or null for a root page or query-only row.

`topQueries` accepts 0–5 and is valid only with `dimension: "page"`. It uses
one additional paged `page+query` fetch series for the current period, with the
same filters and search type, then groups queries per page and ranks them by
clicks. It does not make a request per page. The first query is the primary
keyword; its metrics remain query metrics, not page totals.

Each fetch series requests pages of 25,000 rows up to an internal cap of
100,000. Hitting that cap sets `meta.truncated` and warns that new/lost statuses
may be wrong. Google also returns top rows under its own limits, so a result
below the internal cap is not proof that every Google row was available.
`meta` reports periods, filters, search type, data state, Pacific timezone,
rows fetched per period, rows matched before the limit, rows returned, warnings
and the first incomplete date when Google supplies it.

## Data rules

- Default requests use final data and comparison dates exclude recent days.
  GSC dates are Pacific time, not the user's local timezone.
- Query rows do not add up to page totals because Google hides anonymized
  queries. Page totals always come from a page-only fetch.
- Merged average positions are weighted by impressions; CTR is clicks divided
  by impressions and remains a 0–1 fraction.
- Page URLs lose fragments and trailing slashes before joining, except for a
  site root. Path case, protocol and hostname variants remain distinct.
- Read position and impressions changes together. Both numbers are returned;
  neither establishes a cause, and the tools make no recommendations.

Google documents the wire field as `metadata.first_incomplete_date`, available
only with `dataState: "all"`, date grouping and incomplete data in the requested
range. The extension passes it through as `firstIncompleteDate`; page/query
comparisons usually rely on the three-day lag instead.
The [Search Analytics reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
shows lowercase country response keys such as `usa` and device filter values
`DESKTOP`, `MOBILE`, `TABLET`. Filter expressions pass through verbatim; the
README example uses `usa` for the United States.

## AirOps Onsite example

One call returns page totals, their changes, folders and each page's top query:

```json
{
  "siteUrl": "https://example.com/",
  "dimension": "page",
  "filters": [
    { "dimension": "country", "operator": "equals", "expression": "usa" },
    { "dimension": "page", "operator": "includingRegex", "expression": "^https://example\\.com/blog/" }
  ],
  "topQueries": 1,
  "sortBy": "clicks"
}
```

Call `googleSearchConsole_compare_periods` with that object. Omit the page regex
for all folders; add a device filter when needed. For a refresh list, use
`sortBy: "clicksDelta"` and an agreed `minImpressions` floor.

## Connection and failures

Tools return structured connection signals for `not_connected`, `expired`,
`insufficient_scope`, `wrong_account` and `rate_limited`, with
`connected: false`, `provider: "google"`, a recovery message and authorization
link when available. Every refusal, including rate limiting, has top-level
`isError: true`; success schemas do not describe these refusal objects.

HTTP 401 requests reconnection; 429 and quota-related 403 responses ask the
caller to wait and retry. Only a missing-scope 403 requests additional
permission. Property-access and API-disabled 403 responses throw a clear
property/setup error instead of suggesting reconnection; other request errors
retain Google's message. Exact Google error bodies vary; see the
[standard errors reference](https://developers.google.com/webmaster-tools/v1/errors).
HTTP requests time out after 15 seconds. Each tool checks the userinfo account
before reading Search Console data to detect a mismatched connection.

No sitemap submission/deletion, site changes, service accounts, scheduled jobs,
or cause diagnosis are included.
