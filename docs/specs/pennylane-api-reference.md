# Pennylane Company API — Reference for the `pennylane` extension

> Local reference so we don't re-crawl the docs. Compiled 2026-07-02 from
> `https://pennylane.readme.io/` (machine-readable index: `https://pennylane.readme.io/llms.txt`).
> Scope of our extension (Sally): **list/search/read quotes & invoices, and create draft quotes & invoices** in Pennylane, to compare against Floriane's manual invoices and (later) migrate recurring invoices.

## TL;DR — decisions for the build

- **Use API v2 exclusively.** Base URL `https://app.pennylane.com/api/external/v2`. v1 (`https://api.pennylane.com/v1`) is deprecated ("completely deprecated by end of 2025") — as of today it's past sunset; don't build on it.
- **Auth:** `Authorization: Bearer <token>` — a **Company API Token** (self-serve: `Settings > Connectivity > Developers`, pick Read-only or Read-and-write, choose expiry). OAuth2 only needed for a multi-tenant partner integration. Verify a token with `GET /me`.
- **Rate limit:** 25 requests / 5 s **per token**; `429` + `retry-after`. `ratelimit-*` headers on every response — self-throttle.
- **Pagination:** cursor-based (`cursor` / `limit`, response `items` / `has_more` / `next_cursor`). Default limit 20, max 100.
- **Filtering:** `filter` query param = URL-encoded JSON array of `{field, operator, value}`, AND-combined. Operators: `eq, not_eq, lt, lteq, gt, gteq, in, not_in, start_with`.
- **Money is decimal strings** (`"230.32"`, up to 6 decimals on unit prices) — never floats/cents. Dates `YYYY-MM-DD`. IDs are `int64`.
- **No idempotency keys** — we must dedupe creates client-side (use `external_reference`).
- **`external_reference`** field (on customers, products, quotes, invoices) is our hook to correlate Pennylane records with **Pipedrive deal/org IDs**. Must be unique per resource type; filterable.
- **⚠️ Quotes have no "draft" status.** Quote status enum is `pending | accepted | denied | invoiced | expired`; a created quote is always `pending`. "Draft" exists **only for customer invoices** (`draft: true`). See §3.0.
- **Invoice drafts** are first-class: `POST /customer_invoices` with `draft: true`, editable via `PUT`, deletable via `DELETE` (no accounting impact — matches the "brouillons supprimables" requirement), finalize via `PUT .../finalize`.
- **Quote → invoice** conversion exists (v2 only): `POST /customer_invoices/create_from_quote` with `draft: true|false`.

## Contents
- §1 Core mechanics (auth, versioning, rate limits, pagination, filtering, errors, conventions)
- §2 Customer invoices (list / get / create draft / finalize / delete / PDF)
- §3 Quotes / estimates (list / get / create / update-status / convert / PDF)
- §4 Supporting resources (customers, products, VAT/ledger, currencies, external_reference)
- §5 Scopes cheat-sheet
- §6 Open questions to verify against a sandbox

Source URLs are cited inline per section.

---

# §1. Core mechanics

_Source: getting-started, api-v2-vs-v1, generating-my-api-token, oauth-20-walkthrough, v2-scopes, rate-limiting-1, using-cursor-based-pagination, setting-up-filters, error-handling-status-codes, 2026-api-changes-guide._

## 1.0 Two API generations

| | v1 (legacy) | v2 (current) |
|---|---|---|
| Base URL | `https://api.pennylane.com/v1` | `https://app.pennylane.com/api/external/v2` |
| Status | **Deprecated** ("fully retired end of 2025") — treat as sunset | **GA / official stable** |
| IDs | `source_id`-based | internal numeric `int64` (v1 responses carried a `v2_id` to help migrate) |
| Pagination | offset (`page`/`per_page`) | cursor (`cursor`/`limit`) |
| Scopes | coarse (`customer_invoices`, `accounting`) | granular per-resource, `:readonly`/`:all` split |
| Resource creation | nested (customer + invoice in one call) | each resource via its own endpoint, referenced by id |
| Numbers | native JSON floats | **decimal strings** |
| Nested collections | arrays of child ids | `{url}` links to sub-collections |
| Renames | — | `plan_item`→`ledger_account`, `Estimates`→`Quotes`, `customer_validation_needed`→`import_as_incomplete` |

Versioning is in the URL path, not headers. There are separate Firm API (`firm-pennylane.readme.io`) and Firm Group API products sharing the same mechanics — out of scope for us (we're a single Company).

## 1.1 Authentication

All auth uses `Authorization: Bearer <TOKEN>`.

| Role | Auth | How to get it |
|---|---|---|
| **Company** (us) | Company API Token | Self-serve: `Settings > Connectivity > Developers` → Generate → API V2 → Read-only or Read-and-write → expiry (1mo / 6mo / 12mo / Unlimited) → shown **once**, copy immediately |
| Firm | Firm API Token | Firm dashboard |
| Integration partner | OAuth 2.0 | Contact Pennylane Partnerships to register an app |

- Token is bound to **one company**; a company can have many tokens with independent scopes/expiry.
- Read-only token on a write call → `403`.
- **Verify a token:** `GET /api/external/v2/me` (no scope required) → returns `{user, company}`.

```bash
curl https://app.pennylane.com/api/external/v2/me -H "Authorization: Bearer <TOKEN>"
```

**OAuth2** (only if we ever go multi-tenant): Authorization Code flow at `https://app.pennylane.com/oauth/{authorize,token,revoke}`. Access token 24h (`expires_in: 86400`), refresh token 90 days with **Refresh Token Rotation** (each refresh invalidates the old refresh+access token; avoid concurrent refreshes). `scope` is space-separated, e.g. `customers:all customer_invoices:all`.

**Sandbox:** Company creates one from the live account (profile → Test environment → Create my sandbox) → a second account `Sandbox – [email]`, same base URLs, different token. Sandbox needs manual setup (address, bank account, logo, sequential invoice numbering) before invoice endpoints work. Rate limits apply identically.

## 1.2 Rate limiting

_Source: rate-limiting-1_

- **25 requests / 5 seconds, per token.** All endpoints, sandbox + prod.
- Exceed → `429 Too Many Requests`, body `Rate limit exceeded. Please retry in X seconds.`
- Headers **on every response** (not just 429): `ratelimit-limit` (25), `ratelimit-remaining`, `ratelimit-reset` (unix ts). `retry-after` (seconds) is 429-only.
- Retry `429/500/503` with backoff honoring `retry-after`. **Never** retry `400/401/403/404/422`.

Given the deal-scanning workflow, use the `close_date` / `date` filters (below) to keep request volume within budget, exactly as the client call anticipated.

## 1.3 Pagination

_Source: using-cursor-based-pagination_

Response envelope:
```json
{ "items": [ /* ... */ ], "has_more": true, "next_cursor": "eyJpZCI6MTAwfQ==" }
```
- `cursor` (opaque, from previous `next_cursor`; omit for first page) + `limit` (default **20**, max **100** for customer_invoices — varies per endpoint, check its reference page).
- **The cursor encodes position only, NOT filter/sort** — you must re-send the same `filter` and `sort` params on every page or you'll silently get unfiltered results.
- Invalid cursor → `400`. Don't persist cursors long-term.
- Changelog endpoints use the same envelope but default limit 20, **max 1000**, and forbid combining `start_date` + `cursor`.

## 1.4 Filtering & sorting

_Source: setting-up-filters_

`filter` query param = URL-encoded JSON array of `{field, operator, value}`, **AND-combined**:
```json
[{"field":"date","operator":"gteq","value":"2025-06-01"},
 {"field":"customer_id","operator":"in","value":[111,222]}]
```
Operators: `eq, not_eq, lt, lteq, gt, gteq, in, not_in, start_with` (prefix `ILIKE 'x%'`).

**Filterable fields are per-endpoint** — see each section below. Sorting: `sort=field` (asc) / `sort=-field` (desc); fields & defaults per-endpoint (e.g. `customer_invoices` default `-id`, filterable/sortable on `id`,`date`).

`include=<relation>` (e.g. `include=invoice_lines`) eager-loads a relation into a separate `included` block — **experimental**, avoid depending on it.

## 1.5 Errors

_Source: error-handling-status-codes_

Common envelope: `{ "error": "unprocessable_entity", "message": "...", "details": {field, issue} }`. Some 404/409 use a terser `{ "status": 404, "error": "Couldn't find Journal with 'id'=123" }` — **handle both shapes.**

| Code | Meaning | Notes |
|---|---|---|
| 200/201/204 | OK / Created / No Content | 204 e.g. send-by-email, mark-as-paid, delete |
| 400 | Bad Request | malformed JSON, wrong type, **amount sent as number not string** |
| 401 | Unauthorized | token missing/invalid/expired |
| 403 | Forbidden | valid token, missing scope (e.g. read-only on a write) |
| 404 | Not Found | wrong id, or record belongs to another company |
| 409 | Conflict | re-importing a `file_attachment_id` already used |
| 422 | Unprocessable Entity | business rule: unbalanced lines, VAT/total mismatch, invalid VAT code, duplicate `external_reference` — inspect `details` |
| 429 | Too Many Requests | see §1.2 |
| 500/503 | Server error / Unavailable | transient, retry with backoff |

Two validation layers: **schema** (types/required) and **business** (totals/VAT/dates/ledger balance — most 422s). Invoice-line rounding tolerance: up to **1 cent per line** between stated totals and the sum of lines.

## 1.6 Idempotency — none

- **No `Idempotency-Key` mechanism.** Pennylane: *"does not enforce idempotency on creation endpoints… If the same request is sent twice, you may create duplicates."*
- One exception: invoice **import** endpoints reject re-uploading the **same `file_attachment_id`** with `409` (attachment-based dedup, not a general key).
- **We must dedupe creates client-side** — before POSTing, look up by `external_reference` (§4.5), and after a `500`/timeout, check whether the write landed.

## 1.7 Request/response conventions

| Convention | v2 behavior |
|---|---|
| Content-Type | `application/json` (except multipart file uploads) |
| IDs | integer `int64`, e.g. `42` |
| Money | **decimal strings**, e.g. `"230.32"`; foreign currency exposes `amount` (EUR) + `currency_amount` (native) + `exchange_rate` (`"1.0"` for EUR); unit prices up to 6 decimals |
| Currency | ISO 4217 string, default `EUR` |
| Dates | `YYYY-MM-DD` |
| Timestamps | ISO 8601 date-time (`created_at`/`updated_at`) |
| String length | default max 2000 chars/field (inline exceptions) |
| Nested collections | `{url}` link to sub-collection endpoint |
| File uploads | separate `file_attachment` resource: `POST /file_attachments` (max 100MB) → reference returned `file_attachment_id`. Not into DMS/GED |
| Change tracking | per-resource `GET /changelogs/<resource>` — insert/update/delete ops, oldest-first by `processed_at`, 4-week retention, cursor-paginated (max limit 1000). Cheap incremental sync vs. re-listing |

> **2026 API changes (now permanent, cleanup phase started 2026-07-01):** ledger-only endpoints (`journals`, `ledger_accounts`, `ledger_entries`, `trial_balance`, `fiscal_years`) are on new behavior unconditionally — the `X-Use-2026-API-Changes` header/param is now ignored. Notable: the old `ledger` scope is gone (use `ledger_accounts:*`, `ledger_entries:*`, `journals:*`); those endpoints are now cursor-paginated; ledger IDs are unsuffixed. Relevant only if we touch ledger accounts for VAT resolution (§4.3).

---

# §2. Customer invoices (factures clients)

_Source: getcustomerinvoices, getcustomerinvoice, postcustomerinvoices, updatecustomerinvoice, deletecustomerinvoices, finalizecustomerinvoice, markaspaidcustomerinvoice, importcustomerinvoices, createcustomerinvoicefromquote, getcustomerinvoiceschanges, filter-my-customer-invoices, filter-my-draft-invoices, import-vs-create-a-customer-invoice._

All v2. Scope: `customer_invoices:all` (write) or `customer_invoices:readonly` (read). Lists include **credit notes** (`credit_note: true`).

## 2.1 List — `GET /customer_invoices`

Query params: `cursor`, `limit` (1–100, default 20), `sort` (`id`|`date`, prefix `-`, default `-id`), `filter`, `include` (`invoice_lines`, experimental).

**Filterable fields:**

| Field | Operators |
|---|---|
| `id`, `date`, `customer_id`, `billing_subscription_id`, `quote_id` | `lt, lteq, gt, gteq, eq, not_eq, in, not_in` |
| `invoice_number`, `flow_id` | `eq, not_eq, in, not_in` |
| `draft`, `credit_note` | `eq` (boolean) |
| `external_reference` | `eq` |
| `category_id` | `in` |

- **Only drafts:** `filter=[{"field":"draft","operator":"eq","value":"true"}]` (OpenAPI-confirmed; `status`-based filtering appears in prose guides but is unconfirmed in the schema — prefer `draft eq`).
- **June "Won" deals:** `filter=[{"field":"date","operator":"gteq","value":"2025-06-01"},{"field":"date","operator":"lteq","value":"2025-06-30"}]`.
- **By Pipedrive deal id:** `filter=[{"field":"external_reference","operator":"eq","value":"<deal_id>"}]`.

Response: `{ items: [<Customer Invoice>], has_more, next_cursor }`.

## 2.2 Get one — `GET /customer_invoices/{id}`

Path `id` (int64). Returns the full **Customer Invoice** object (same shape in list `items[]`, create, finalize). Key fields:

| Field | Type | Description |
|---|---|---|
| `id` | int64 | |
| `invoice_number` | string | e.g. `"F20230001"` (assigned at finalize) |
| `status` | enum | see §2.6 |
| `draft` | boolean | **true = unfinalized draft** |
| `paid` | boolean | |
| `currency` | string | ISO 4217, default `EUR` |
| `amount` | string | total in EUR |
| `currency_amount` / `currency_amount_before_tax` | string | total in invoice currency (with/without tax) |
| `tax` / `currency_tax` | string | taxable amount (EUR / currency) |
| `exchange_rate` | string | `"1.0"` if EUR |
| `date` | date, nullable | issue date |
| `deadline` | date, nullable | payment deadline |
| `language` | enum | `fr_FR`,`en_GB`,`de_DE` |
| `discount` | `{type: absolute\|relative, value}`, nullable | |
| `customer` | `{id, url}`, nullable | link to `/customers/{id}` |
| `invoice_lines` | `{url}` | link to lines sub-resource |
| `public_file_url` | string, nullable | **PDF URL, expires 30 min** |
| `filename` | string, nullable | |
| `remaining_amount_with_tax` / `_without_tax` | string | left to pay |
| `external_reference` | string | our Pipedrive correlation id |
| `quote` | `{id}`, nullable | originating quote |
| `credited_invoice` | `{id, url}`, nullable | for credit notes |
| `billing_subscription` | `{id}`, nullable | if from a recurring subscription |
| `payments`, `matched_transactions`, `appendices`, `categories`, `custom_header_fields` | `{url}` | sub-resource links |
| `created_at` / `updated_at` / `archived_at` | date-time | |

**Invoice line** (`GET /customer_invoices/{id}/invoice_lines`): `id`, `label`, `unit`, `quantity`, `description`, `product {id,url}` (nullable), `vat_rate` (enum, e.g. `FR_200`), `raw_currency_unit_price` (excl. tax, ≤6 dec), `amount`/`currency_amount` (incl. tax), `tax`/`currency_tax`, `discount`, `section_rank`, `imputation_dates {start,end}`.

## 2.3 Create — `POST /customer_invoices`

Creates invoices **from structured data** (Pennylane renders the PDF). Distinct from `/import` (§2.7). The body is `anyOf` two shapes discriminated by **`draft`**:

- **`"draft": true`** → editable Draft. **← what we use.**
- **`"draft": false` or omitted** → Finalized immediately (numbering + PDF + ledger entry; **no longer editable** — reverse only via credit note).

### Draft request body

| Field | Type | Req | Notes |
|---|---|---|---|
| `date` | date | ✅ | |
| `deadline` | date | ✅ | payment deadline |
| `customer_id` | int64 | ✅ | **must be an existing customer** — no inline creation in v2 (resolve/create first, §4.1) |
| `draft` | `true` | ✅ | literal `true` |
| `invoice_lines` | array (≥1) | ✅ | line shapes below |
| `customer_invoice_template_id` | int64 | | PDF template |
| `pdf_invoice_subject` / `pdf_invoice_free_text` / `pdf_description` | string | | PDF text |
| `currency` | enum | | default `EUR` |
| `language` | enum | | default from customer/company |
| `discount` | `{type, value}` | | invoice-level |
| `invoice_line_sections` | `[{title, description, rank}]` | | group lines |
| `label` | string (≤2000) | | accounting label; auto if omitted |
| `external_reference` | string | | our Pipedrive deal id; auto if omitted |
| `special_mention` | string (≤20000) | | |

(Finalized body additionally accepts `transaction_reference` for auto-reconciliation — N/A for drafts.)

### Line item — two shapes (`oneOf`)

**A. Product-based** — `product_id` (✅) auto-fills `label`, `raw_currency_unit_price`, `unit`, `vat_rate`, `ledger_account_id`; `quantity` (✅); override any of the auto-filled fields; optional `section_rank`, `discount`, `description`.

**B. Standard (free-form, no product)** — `label` ✅, `quantity` ✅, `raw_currency_unit_price` ✅ (string, ≤6 dec, excl. tax), `unit` ✅, `vat_rate` ✅ (enum); optional `ledger_account_id` (if omitted → company default chart-of-accounts/VAT mapping), `section_rank`, `discount`, `description`.

VAT is per-line via `vat_rate` (e.g. `FR_200`=20%, `FR_100`=10%, `FR_55`=5.5%, `exempt`=0%); Pennylane computes tax & totals server-side.

### Minimal draft example
```json
POST /api/external/v2/customer_invoices
{
  "customer_id": 123,
  "date": "2025-06-15",
  "deadline": "2025-07-15",
  "draft": true,
  "invoice_lines": [
    { "label": "Consulting services", "quantity": 2, "unit": "hour",
      "raw_currency_unit_price": "100.00", "vat_rate": "FR_200" }
  ],
  "external_reference": "pipedrive-deal-4567"
}
```
→ `201`, full invoice object with `status: "draft"`, `draft: true`. Errors: `400`/`403`/`404` (bad `customer_id`)/`422` (totals/VAT mismatch).

## 2.4 Update / finalize / delete a draft

- **Update:** `PUT /customer_invoices/{id}` — full replace, same `anyOf` body as create. Edits a draft's lines/customer/dates before finalizing. (Separate `PUT .../update_imported` is for *imported* invoices, "not applicable for drafts".)
- **Finalize:** `PUT /customer_invoices/{id}/finalize` — draft → finalized; assigns `invoice_number`, generates PDF; **irreversible edit-lock**. No body beyond the request.
- **Delete:** `DELETE /customer_invoices/{id}` → `204`. **Drafts only** (finalized can't be deleted). No accounting trace — matches the "brouillons supprimables sans impact comptable" requirement. To undo a finalized invoice, issue a credit note (`POST /customer_invoices/{id}/link_credit_note`, body `{credit_note_id}`).
- **Mark paid:** `PUT /customer_invoices/{id}/mark_as_paid` → `204` (flips `paid`, no bank reconciliation).

## 2.5 Create from quote — `POST /customer_invoices/create_from_quote`

Body: `quote_id` ✅, `draft` ✅ (`true` = draft invoice, `false` = finalized), optional `external_reference`, `customer_invoice_template_id`. Inherits the quote's customer + lines. → `201` invoice object. **This is the natural "Won deal has a quote → draft invoice" path.**

## 2.6 Statuses

`status` enum: `archived, incomplete, cancelled, paid, partially_paid, partially_cancelled, upcoming, late, draft, credit_note, proforma, shipping_order, purchasing_order, estimate_pending, estimate_accepted, estimate_invoiced, estimate_denied`. Plus independent booleans `draft`, `paid`.

Practical lifecycle: `draft` —finalize→ `upcoming`|`late` —payment/mark_as_paid→ `partially_paid`→`paid` —link_credit_note→ `cancelled`. `incomplete` = imported with `import_as_incomplete: true`.

## 2.7 PDF, attachments, `/create` vs `/import`

- **PDF:** `public_file_url` on the invoice object, **expires 30 min** — re-fetch for a fresh link.
- **Appendices:** `GET`/`POST /customer_invoices/{id}/appendices` (multipart `file`, PDF/PNG/JPEG/TIFF/BMP/GIF).
- **Send by email:** `POST /customer_invoices/{id}/send_by_email` (optional `{recipients}`) → `204`; finalized only, may `409` if PDF not yet generated (retry).
- **`/create` vs `/import`:** use **`/create`** (§2.3) — Pennylane renders the PDF and it supports `draft`. `POST /customer_invoices/import` is for registering a PDF that already exists elsewhere; **no draft mode**, needs a pre-uploaded `file_attachment_id`, always finalized/`incomplete`. Not our path (documented for disambiguation only).
- **Changelog:** `GET /changelogs/customer_invoices?start_date=...` — cheap change polling (4-week retention).

---

# §3. Quotes / estimates (devis)

_Source: listquotes, getquote, postquotes, updatequote, updatestatusquote, createcustomerinvoicefromquote, sendbyemailquote, getquotechanges, api-v2-vs-v1._

All v2 (`/quotes`). Scope: `quotes:all` (write) / `quotes:readonly` (read). v1 called these **Estimates** (`/customer_estimates`) — deprecated, ignore.

## 3.0 ⚠️ Critical limitation: no draft quotes

The quote `status` enum is **only** `pending | accepted | denied | invoiced | expired`. A created quote is **always `pending`** — there is no "draft"/"not-yet-sent" state, and **no `draft`/`status` field on the create payload**. "Draft" exists solely for customer *invoices*.

Implication for Sally's "generate a devis" flow: either (a) create the quote as `pending` and simply don't send it by email (no customer-facing push happens unless we call `send_by_email`), or (b) don't create the quote via API until it's final. **Flag to Floriane/stakeholders** — this is a product limitation, not a doc gap. There is also **no `DELETE` for quotes** in either version — retire via status `denied`/`expired`.

## 3.1 List — `GET /quotes`

Query: `cursor`, `limit` (1–100, default 20), `sort` (`id`, default `-id`), `filter`. **Filterable: `id`, `customer_id` (comparisons), `status` (`eq,not_eq,in,not_in`).** No documented date-range or `external_reference` filter (the filter DSL's `lt`/`gt` *may* work on `date`/`deadline` but it's unconfirmed — see §6). To find a quote by Pipedrive deal id: filter by `customer_id` (supported) then match `external_reference` client-side (it's returned on the quote object). No local map required.

Response: `{ has_more, next_cursor, items: [<Quote>] }`.

## 3.2 Get one — `GET /quotes/{id}`

Full **Quote** object: `id`, `quote_number`, `status`, `label`, `currency`, `amount`, `currency_amount`, `currency_amount_before_tax`, `tax`/`currency_tax`, `exchange_rate`, `date`, `deadline` (validity), `language`, `discount`, `customer {id,url}`, `invoice_lines {url}`, `invoice_line_sections {url}`, `linked_invoices {url}`, `pdf_invoice_subject`/`pdf_invoice_free_text`/`pdf_description`, `quote_template {id}`, `appendices {url}`, `public_file_url` (**PDF, expires 30 min**), `filename`, `special_mention`, `external_reference`, `created_at`/`updated_at`/`archived_at`.

## 3.3 Create — `POST /quotes`

| Field | Type | Req | Notes |
|---|---|---|---|
| `date` | date | ✅ | issue date |
| `deadline` | date | ✅ | validity deadline |
| `customer_id` | int64 | ✅ | existing customer only (§4.1) |
| `invoice_lines` | array (≥1) | ✅ | **same product-based / standard line shapes as invoices, §2.3** |
| `currency` | enum | | default `EUR` |
| `discount` | `{type, value}` | | |
| `invoice_line_sections` | `[{title, description, rank}]` | | |
| `external_reference` | string | | Pipedrive deal id; auto if omitted |
| `language`, `pdf_invoice_subject`, `pdf_invoice_free_text`, `pdf_description`, `quote_template_id`, `special_mention` | | | optional |

No `status`/`draft` field. → `201`, quote object with `status: "pending"`.

```json
POST /api/external/v2/quotes
{
  "date": "2026-07-02", "deadline": "2026-08-02", "customer_id": 42,
  "pdf_invoice_subject": "Consulting proposal", "external_reference": "pipedrive-deal-4567",
  "invoice_lines": [
    { "label": "Consulting fees", "quantity": 2, "unit": "day",
      "raw_currency_unit_price": "500.00", "vat_rate": "FR_200" }
  ]
}
```

## 3.4 Update / status / convert / PDF

- **Update:** `PUT /quotes/{id}` — all fields optional; `invoice_lines` uses a diff object `{create:[...], update:[{id,...}], delete:[ids]}` (not a flat array). Status not editable here.
- **Update status:** `PUT /quotes/{id}/update_status`, body `{"status": "accepted"}` (enum as §3.0).
- **Convert to invoice:** `POST /customer_invoices/create_from_quote` (§2.5) — v2 only, supports `draft: true|false`.
- **PDF:** `public_file_url` (expires 30 min; generation is async — may not resolve for a few minutes after create).
- **Appendices:** `GET`/`POST /quotes/{id}/appendices` (multipart, same content types as invoices).
- **Send by email:** `POST /quotes/{id}/send_by_email` (optional `{recipients}`) → `204`, `409` if PDF not ready.
- **Changelog:** `GET /changelogs/quotes`.

---

# §4. Supporting resources — customers, products, VAT, currency

_Source: getcustomers, getcustomer, postcompanycustomer, postindividualcustomer, filter-my-customers, getproducts, getproduct, postproducts-1, getledgeraccounts, handle-vat-rates-by-ledger-accounts, v2-scopes._

## 4.1 Customers

Two types: **company** (`customer_type: "company"`, entreprises) and **individual** (`"individual"`, particuliers). v2 splits create/update by type but lists/reads via a unified endpoint.

**List:** `GET /customers` (scope `customers:*`). Params `cursor`, `limit` (1–100/20), `sort` (`id`), `filter`.

Filterable: `id` (comparisons), `customer_type` (`eq`,`not_eq`; `"company"`/`"individual"`), `ledger_account_id`, `name` (`start_with`,`eq` — prefix only), **`external_reference`** (`start_with`,`eq`,`not_eq`,`in`,`not_in`), `reg_no` (SIREN, company only), `emails` (`in`).

**Get:** `GET /customers/{id}` (unified) or `/company_customers/{id}` / `/individual_customers/{id}` (typed, 404 on mismatch).

**Company customer schema:** `id`, `name`, `customer_type`, `vat_number` (e.g. `FR12345678901`), `reg_no` (SIREN), `billing_iban`, `payment_conditions` (`upon_receipt`,`custom`,`7_days`,`15_days`,`30_days`,`30_days_end_of_month`,`45_days`,`45_days_end_of_month`,`60_days`), `recipient`, `phone`, `reference`, `notes`, `ledger_account {id}`, `emails[]`, `billing_address {address, postal_code, city, country_alpha2}` (all required), `delivery_address` (same), `external_reference`, `billing_language` (`fr_FR`/`en_GB`/`de_DE`), `mandates`/`contacts` `{url}`, `created_at`/`updated_at`. **Individual customer:** same minus `name`/`vat_number`/`reg_no`, plus `first_name`, `last_name`.

**Create company:** `POST /company_customers` (scope `customers:all`). Required `name`, `billing_address`. Optional `vat_number`, `reg_no`, `emails[]`, `external_reference` (ours or auto), `payment_conditions` (default `30_days`), `phone`, `delivery_address`, `billing_iban`, `recipient`, `reference`, `notes`, `billing_language`, `ledger_account.number` (note: **number**, not id, on create).
```json
POST /api/external/v2/company_customers
{ "name": "ACME Corp", "vat_number": "FR12345678901", "reg_no": "123456789",
  "emails": ["billing@acme.com"], "external_reference": "pipedrive-org-88",
  "billing_address": {"address":"123 Business St","postal_code":"75001","city":"Paris","country_alpha2":"FR"} }
```
**Create individual:** `POST /individual_customers`. Required `first_name`, `last_name`, `billing_address`.
**Update:** `PUT /company_customers/{id}` / `PUT /individual_customers/{id}` (same shape, patchable).

**Referencing a customer from an invoice/quote:** by internal numeric `customer_id` only — **you cannot pass `external_reference` as the pointer**. Resolve first:
1. `GET /customers?filter=[{"field":"external_reference","operator":"eq","value":"<pipedrive_org_id>"}]`
2. found → use its `id`; not found → `POST /company_customers` (or individual) with `external_reference` set, capture `id`.

## 4.2 Products

**List:** `GET /products` (scope `products:*`). Filter: `id`, `label` (`eq`,`in`), `reference` (`eq`,`in`), `external_reference` (`eq`,`not_eq`,`in`,`not_in`).

**Get:** `GET /products/{id}` → `id`, `label`, `description`, `external_reference`, `price_before_tax` (string), `price` (incl. tax, computed), `vat_rate` (enum, §4.3), `unit` (free text), `currency` (default `EUR`), `reference` (SKU), `ledger_account {id}`, `archived_at`, `created_at`/`updated_at`.

**Create:** `POST /products` (scope `products:all`). Required `label`, `price_before_tax`, `vat_rate`. Optional `description`, `currency`, `external_reference`, `ledger_account_id` (**integer id** here, unlike customers' `.number`), `reference`, `unit`.

**Line items can be fully free-form (no `product_id`)** — confirmed by the `oneOf` "Standard line" variant and the official minimal-invoice tutorial. So we don't strictly need to create products to draft invoices/quotes; free-form lines suffice.

## 4.3 VAT / tax rates & ledger accounts

- **No "list VAT rates" endpoint** — `vat_rate` is a fixed enum (~180 country codes) reused on products, invoice lines, quote lines, ledger accounts.
- Format `{ISO2}_{rate×10}`: `FR_200`=20%, `FR_100`=10%, `FR_55`=5.5% (**not `FR_055`** — a tutorial typo), `FR_21`=2.1%, plus `exempt` (0%), `any` (shows "N/A" in UI), and `intracom_*`/`extracom`/`crossborder`/`mixed` for cross-border, and codes for ~30 EU/EEA countries.
- **VAT ↔ accounting:** a ledger account *number* (e.g. `706000000009`) has multiple *items* (distinct `id`s), one per VAT rate. To post at a specific rate, use that item's `id` as `ledger_account_id`. **If you omit `ledger_account_id` on a line, Pennylane auto-applies the company default mapping from the line/product `vat_rate`** — simplest for us.
- **Ledger accounts:** `GET /ledger_accounts` (scope `ledger_accounts:*`; the old `ledger` scope is retired per the 2026 changes). Filter `id`, `number` (`start_with`,`eq`,`in`), `enabled`. Schema: `id`, `number`, `label`, `vat_rate`, `country_alpha2`, `enabled`, `type`, `letterable`. French revenue prefixes: `706xxx` services, `707xxx` goods, `4457` VAT collected.

## 4.4 Currencies

`currency` is a plain enum field (no endpoint), default `EUR`, ~150 ISO 4217 codes. Non-EUR invoices/quotes expose `currency_amount`, `currency_amount_before_tax`, `currency_tax`, `exchange_rate`. All monetary values are strings.

## 4.5 External reference — linking to Pipedrive

**`external_reference`** is a **native, built-in field** (not a custom field you define — Pennylane ships it on every record specifically to hold *your* external system's id; there's exactly one string per record, not a key/value custom-field system). Present on **customers, products, quotes, customer invoices**. Optional on create (auto-generated UUID-ish if omitted), **must be unique** per resource type, filterable (`eq`,`not_eq`,`in`,`not_in`; `start_with` on customers/products) — except on quotes, where it's returned but not server-side filterable. v1 name was `source_id`.

**Our correlation strategy:** set `external_reference` = Pipedrive deal id (e.g. `pipedrive-deal-<id>`) on the invoice/quote, and Pipedrive org/person id on the customer. Lookups:
- customer for an org: `GET /customers?filter=[{"field":"external_reference","operator":"eq","value":"<org_id>"}]`
- invoice for a deal: `GET /customer_invoices?filter=[{"field":"external_reference","operator":"eq","value":"<deal_id>"}]` (invoices support only `eq` on this field).
- **Caveat:** the `GET /quotes` filter does **not** expose `external_reference` (it's returned on the object, just not filterable) — to find a quote by deal id, filter by `customer_id` and match `external_reference` client-side. No local map needed. (Verify in §6.)

No usable tags/notes correlation — `notes`/`reference` are free-text, not indexed. Use `external_reference`.

---

# §5. Scopes cheat-sheet (for our extension)

| Scope | Grants |
|---|---|
| `customer_invoices:readonly` / `:all` | list/get invoices / + create draft, finalize, delete, mark-paid, create-from-quote |
| `quotes:readonly` / `:all` | list/get quotes / + create, update, update-status |
| `customers:readonly` / `:all` | list/get customers / + create & update |
| `products:readonly` / `:all` | list/get products / + create & update |
| `ledger_accounts:readonly` / `:all` | (only if resolving VAT-specific ledger accounts manually) |

Minimum for the read + draft-create workflow: `customer_invoices:all`, `quotes:all`, `customers:all`, `products:readonly` (or `:all` if we create products). `GET /me` needs no scope.

---

# §6. Open questions — verify against a sandbox before/while building

1. **Quotes date filtering:** `GET /quotes` documents only `id`/`customer_id`/`status` filters — test whether `date`/`deadline` comparisons work via the generic filter DSL, since the "filter by close date" optimization from the client call depends on it.
2. **Quotes `external_reference` filter:** confirmed absent from docs (field is returned, just not server-side filterable). Find quotes by deal id via `customer_id` filter + client-side match on `external_reference` — no local map needed.
3. **Invoice `status` vs `draft` filter:** prose guides show `{"field":"status","operator":"eq","value":"draft"}` but the OpenAPI schema only lists `draft eq`. Use `draft eq true`; test `status` filtering if needed.
4. **`PUT /customer_invoices/{id}` on a finalized invoice:** docs imply it fails (finalized = edit-locked); confirm the exact error.
5. **VAT code `FR_55` vs `FR_55` (not `FR_055`):** trust the enum, not the tutorial table.
6. **v1 anything:** deprecated & under-documented — don't use; if forced, verify empirically.
</content>
</invoke>
