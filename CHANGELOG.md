# Changelog

## [Unreleased]

### Added

- MCP OAuth connection routes and per-agent token persistence (ALG-392).

- `gmail` extension with Gmail MCP parity for drafts, threads, labels, and Gmail query search via host-managed Google OAuth.

- `googleDrive` read tools (ALG-358): adds `list_files` (optional name-substring filter + `pageSize`/`pageToken` pagination), `search_files` (Drive `q` query syntax), and `read_file` (downloads a file and extracts text — Google Docs/Sheets/Slides are exported to text/CSV, PDF and DOCX are text-extracted) alongside the existing `validate`. All tools consume the injected fresh OAuth token and return the documented not-connected signal (never a raw 401) when no valid connection exists. Read-only only — no write scopes, no mutating tools.

- `googleDrive` extension (ALG-357 tracer bullet): declares an `oauth` requirement for Google (Drive read-only + userinfo.email) and exposes a single `validate` tool that returns connected + the Google account when the host injects a fresh access token, or the documented not-connected signal otherwise. `defineToolExtension` now supports the `oauth: { provider, scopes }` requirement and injects the host-resolved token into `createTools` config.

- Pennylane quote-write path: `create_quote` (creates a `pending` quote — the draft-equivalent, since Pennylane quotes have no draft state — and accepts `external_reference` for correlation/dedup) and `update_quote` (re-reads the target and routes it through the existing `DraftGuard`, refusing to edit any non-`pending` quote; `invoice_lines` uses the `{ create, update, delete }` diff object). No quote finalize/accept/send/status tool is exposed.
- Pennylane draft-write path: `DraftGuard` deep module (pure, synchronous gate that permits mutation only of `draft: true` invoices and `pending` quotes, refusing finalized invoices and accepted/sent quotes; boundary loosens via a constructor parameter), plus `create_invoice_draft` (always creates with `draft: true`, accepts `external_reference` for correlation/dedup) and `update_invoice_draft` (re-reads the target and routes it through `DraftGuard`, refusing to edit a finalized invoice). No finalize or send tool is exposed.
- Pennylane read surface: `get_invoice`, `list_quotes` / `search_quotes` / `get_quote`, `list_customers` / `search_customers` / `get_customer`, `list_products` / `search_products` / `get_product`, and `list_vat_rates`. Quotes are matched on `external_reference` client-side (filtered by `customer_id` server-side); customers are fetchable by id or `external_reference`. Zod schemas added for quote, customer, product, line items, and the VAT rate enum reference.
