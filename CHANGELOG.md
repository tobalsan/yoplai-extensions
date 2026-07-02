# Changelog

## [Unreleased]

### Added

- Pennylane draft-write path: `DraftGuard` deep module (pure, synchronous gate that permits mutation only of `draft: true` invoices and `pending` quotes, refusing finalized invoices and accepted/sent quotes; boundary loosens via a constructor parameter), plus `create_invoice_draft` (always creates with `draft: true`, accepts `external_reference` for correlation/dedup) and `update_invoice_draft` (re-reads the target and routes it through `DraftGuard`, refusing to edit a finalized invoice). No finalize or send tool is exposed.
- Pennylane read surface: `get_invoice`, `list_quotes` / `search_quotes` / `get_quote`, `list_customers` / `search_customers` / `get_customer`, `list_products` / `search_products` / `get_product`, and `list_vat_rates`. Quotes are matched on `external_reference` client-side (filtered by `customer_id` server-side); customers are fetchable by id or `external_reference`. Zod schemas added for quote, customer, product, line items, and the VAT rate enum reference.
