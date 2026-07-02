# Changelog

## [Unreleased]

### Added

- Pennylane read surface: `get_invoice`, `list_quotes` / `search_quotes` / `get_quote`, `list_customers` / `search_customers` / `get_customer`, `list_products` / `search_products` / `get_product`, and `list_vat_rates`. Quotes are matched on `external_reference` client-side (filtered by `customer_id` server-side); customers are fetchable by id or `external_reference`. Zod schemas added for quote, customer, product, line items, and the VAT rate enum reference.
