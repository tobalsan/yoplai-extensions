# Changelog

## [Unreleased]

### Added

- MCP servers now appear as individual extension cards, and agent members can add HTTP(S) servers from the extension list with immediate OAuth authorization or direct no-auth connection (ALG-469).

- MCP OAuth connections and removals record redacted settings audit events when the host supports auditing (ALG-470).

### Changed

- `GET /mcp/servers/personal-status?agent=&url=` reports whether the user already has a usable shared personal grant for a server URL, so adding it "Just me" needs no OAuth popup.
- Personal MCP OAuth connections are shared across agents that configure the same server URL; team connections stay per agent.
- Servers added from the UI get a readable key from their site (`mcp.linear.app` → `linear`, then `linear_2`), and cards show the server-reported name and description (`serverInfo.title`/`description`; sentence-like titles are split at the first colon or dash) once connected, saved as `displayName`/`description` on UI-added `mcp.json` entries. Any server entry, stdio included, may set optional `displayName` and `description` to override the card label (yoplai-only keys; other MCP clients ignore them). Servers without an icon show the official MCP logo.
- MCP routes `GET/POST /mcp/servers/config?agent=&server=` read and edit one HTTP server's `mcp.json` entry (secrets masked, stdio read-only, audited as `mcp.server.update`) (ALG-469).

- HTTP MCP servers without a server-provided icon use their host's website icon, falling back to the root domain; found icons are cached in `<data dir>/mcp/icons.json` (ALG-469).

- MCP loads automatically when an agent has `mcp.json`; server cards show live connection state and app icons when available, while disconnect and removal remain separate actions (ALG-469).

- Google Drive now supports an optional `allowWrite` toggle for creating/editing files and Google Sheets, with mode-specific OAuth scopes and reconnect guidance (ALG-467). The toggle is labeled **Enable creating and writing files**; extensions can set config field labels via `configFieldTitles`.

- Gmail and Google Drive descriptions, agent instructions, and not-connected messages now say connections can be personal (**Just me**) or shared (**Whole team**) instead of "per-agent OAuth"; the READMEs describe the personal-then-team fallback and the current connect flow.

### Fixed

- MCP disconnect removes the selected credential immediately; provider revocation runs in the background so outages cannot block team fallback (ALG-460).

- MCP OAuth refusals in Slack offer one personal connect link, reusing host pairing and confirming the originating thread after authorization.

- MCP **Whole team** connections can only be connected or disconnected by admins in multi-user mode; status reports `canConfigureTeam` so the UI can hide the option.
- Google OAuth tool extensions (Gmail, Google Drive) now resolve the requesting user's personal "Just me" connection before the team one, instead of always reporting not connected.
- MCP OAuth transports now force-refresh and reconnect after a 401, so cached agents keep their MCP tools through token expiry.
- Concurrent MCP OAuth token requests now share one refresh, preserving rotated refresh tokens and avoiding duplicate provider calls.
- Zendesk configuration now rejects invalid subdomains that could redirect API credentials to another host.
- Pipedrive concurrent field-registry cache misses now share one rebuild, preventing duplicate API fetches and cache-write races.
- Pipedrive configuration now rejects invalid domains that could redirect API tokens to another host.
- Pennylane creation requests are no longer automatically replayed after ambiguous server failures, preventing duplicate invoices or quotes; callers can reconcile by `external_reference` before retrying.
- MCP OAuth routes now honor merged root/agent `configPath` settings, and clients that fail tool discovery are closed.
- Jira configuration now rejects invalid subdomains that could redirect API credentials, structured searches enforce the configured project allowlist, and user search pagination is forwarded.
- Hiveage configuration now rejects invalid subdomains that could redirect API credentials to another host.
- Google Sheets requests now honor the configured timeout, and spreadsheet listings can consume their returned pagination token.
- Firecrawl crawl creation now rejects malformed successful responses that omit the job id instead of returning an unusable monitoring instruction.
- Exa research task creation now rejects malformed successful responses that omit the task id instead of returning an unusable polling instruction.
- Scoped Confluence page listings now reject a numeric space id outside the configured space.
- HTTP client errors now retain truncated upstream response bodies with status and endpoint details for actionable diagnostics.

### Added

- MCP OAuth connections support personal or team credentials in the host encrypted store, with requester-specific resolution and legacy team migration (ALG-455).

- Pipedrive Leads inbox read support: `list_leads` (lean projection, `archived_status`/`owner_id`/`person_id`/`organization_id`/`filter_id`/`sort` filters), `get_lead` (full detail with custom fields normalized through the same deal-field schema/registry as `get_deal`), `search_leads`, `list_lead_labels`, `list_lead_sources`, `list_lead_notes`, and `list_lead_activities` (v2 API). A lead's `person_id`/`organization_id` resolve via the existing `get_person`/`get_organization`.

- Pennylane `create_customer` tool for company and individual customers (ALG-421).

- MCP OAuth connection routes and per-agent token persistence (ALG-392).

- `gmail` extension with Gmail MCP parity for drafts, threads, labels, and Gmail query search via host-managed Google OAuth.

- `googleDrive` read tools (ALG-358): adds `list_files` (optional name-substring filter + `pageSize`/`pageToken` pagination), `search_files` (Drive `q` query syntax), and `read_file` (downloads a file and extracts text — Google Docs/Sheets/Slides are exported to text/CSV, PDF and DOCX are text-extracted) alongside the existing `validate`. All tools consume the injected fresh OAuth token and return the documented not-connected signal (never a raw 401) when no valid connection exists. Read-only only — no write scopes, no mutating tools.

- `googleDrive` extension (ALG-357 tracer bullet): declares an `oauth` requirement for Google (Drive read-only + userinfo.email) and exposes a single `validate` tool that returns connected + the Google account when the host injects a fresh access token, or the documented not-connected signal otherwise. `defineToolExtension` now supports the `oauth: { provider, scopes }` requirement and injects the host-resolved token into `createTools` config.

- Pennylane quote-write path: `create_quote` (creates a `pending` quote — the draft-equivalent, since Pennylane quotes have no draft state — and accepts `external_reference` for correlation/dedup) and `update_quote` (re-reads the target and routes it through the existing `DraftGuard`, refusing to edit any non-`pending` quote; `invoice_lines` uses the `{ create, update, delete }` diff object). No quote finalize/accept/send/status tool is exposed.
- Pennylane draft-write path: `DraftGuard` deep module (pure, synchronous gate that permits mutation only of `draft: true` invoices and `pending` quotes, refusing finalized invoices and accepted/sent quotes; boundary loosens via a constructor parameter), plus `create_invoice_draft` (always creates with `draft: true`, accepts `external_reference` for correlation/dedup) and `update_invoice_draft` (re-reads the target and routes it through `DraftGuard`, refusing to edit a finalized invoice). No finalize or send tool is exposed.
- Pennylane read surface: `get_invoice`, `list_quotes` / `search_quotes` / `get_quote`, `list_customers` / `search_customers` / `get_customer`, `list_products` / `search_products` / `get_product`, and `list_vat_rates`. Quotes are matched on `external_reference` client-side (filtered by `customer_id` server-side); customers are fetchable by id or `external_reference`. Zod schemas added for quote, customer, product, line items, and the VAT rate enum reference.
