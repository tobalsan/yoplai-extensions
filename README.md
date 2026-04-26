# AIHub Tool Extensions

Self-contained agent tool packages for external APIs, used with [AIHub](https://github.com/algodyn/aihub).

## Extensions

- **`gsheets`** — Google Sheets read-only access (list, inspect, read tabs/ranges; `read_sheet` supports `rowOffset`, `maxRows`, and `columns`)
- **`hiveage`** — HiveAge invoicing API (invoices, estimates, connections, payments, items, recurring invoices)
- **`notion`** - CRUD operations for Notion pages and databases via Notion API

## Usage

Build and symlink (or copy) individual built extension directories into `$AIHUB_HOME/extensions` (`~/.aihub/extensions` by default), or set `extensionsPath` in `aihub.json`.

```bash
pnpm install
pnpm build
mkdir -p ~/.aihub/extensions
ln -sfn "$PWD/dist/hiveage" ~/.aihub/extensions/hiveage
```

Configure each agent under `agents[].extensions`. Presence opts the agent in;
`enabled: true` is not required. Root `extensions.<id>` is optional and only
needed for shared defaults.

```json
{
  "agents": [
    {
      "id": "sally",
      "name": "Sally",
      "workspace": "~/agents/sally",
      "extensions": {
        "hiveage": {
          "apiKey": "$env:HIVEAGE_API_KEY",
          "subdomain": "$env:HIVEAGE_SUBDOMAIN"
        },
        "gsheets": {
          "serviceAccountJson": "$env:GOOGLE_SERVICE_ACCOUNT_JSON"
        }
      },
      "model": { "provider": "anthropic", "model": "claude-sonnet-4" }
    }
  ]
}
```

You can still put shared defaults at the root and override per agent:

```json
{
  "extensions": {
    "hiveage": { "subdomain": "$env:HIVEAGE_SUBDOMAIN" }
  },
  "agents": [
    {
      "id": "billing",
      "name": "Billing",
      "workspace": "~/agents/billing",
      "extensions": {
        "hiveage": { "apiKey": "$env:HIVEAGE_API_KEY" }
      },
      "model": { "provider": "anthropic", "model": "claude-sonnet-4" }
    }
  ]
}
```
