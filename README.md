# AIHub Connectors

Self-contained agent tool packages for external APIs, used with [AIHub](https://github.com/algodyn/aihub).

## Connectors

- **`gsheets`** — Google Sheets read-only access (list, inspect, read tabs/ranges)
- **`hiveage`** — HiveAge invoicing API (invoices, estimates, connections, payments, items, recurring invoices)

## Usage

Build and symlink (or copy) individual connector directories into your AIHub connectors path (`~/.aihub/connectors/` by default, configurable via `connectors.path` in `aihub.json`).

See [AIHub Connectors Docs](~/code/aihub/docs/connectors.md) for the full guide.
