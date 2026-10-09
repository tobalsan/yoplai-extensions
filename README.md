# Yoplai Tool Extensions

Self-contained agent tool packages for external APIs, used with [Yoplai](https://github.com/algodyn/yoplai).

## Extension catalog

The source directory is the build/install directory name. The extension ID is the key used under `extensions` in Yoplai configuration; the two differ where noted.

| Source directory | Extension ID | Purpose | Required setup |
| --- | --- | --- | --- |
| `confluence` | `confluence` | Confluence search, pages, labels, and attachments | Atlassian subdomain, email, and API token |
| `exa` | `exa` | Exa search, content, and research tasks | API key |
| `firecrawl` | `firecrawl` | Web scraping, crawling, mapping, and extraction | API key |
| [`google-calendar`](src/google-calendar/README.md) | `googleCalendar` | Google Calendar events and availability | Host-managed Google OAuth |
| [`gmail`](src/gmail/README.md) | `gmail` | Gmail drafts, threads, and labels | Host-managed Google OAuth |
| [`google-drive`](src/google-drive/README.md) | `googleDrive` | Read-only Drive search and text extraction | Host-managed Google OAuth |
| `gsheets` | `gsheets` | Spreadsheet discovery, reads, row appends, and range updates | Google service-account JSON |
| `hiveage` | `hiveage` | Hiveage invoices, estimates, payments, and related records | Account subdomain and API key |
| [`jira`](docs/specs/jira-extension-prd.md) | `jira` | Scoped Jira reads and guarded writes | Atlassian subdomain, email, and API token |
| [`mcp`](src/mcp/README.md) | `mcp` | Tools discovered from stdio or remote MCP servers | Explicit `enabled: true` and `mcp.json` |
| [`notion`](docs/2026-04-18-hr-triage-notion-connector-skill.md) | `notion` | Notion data sources, pages, blocks, and file extraction | Integration API key |
| [`pennylane`](docs/specs/pennylane-api-reference.md) | `pennylane` | Pennylane billing reads and guarded draft/quote writes | API token |
| `pipedrive` | `pipedrive` | Read-only Pipedrive CRM and custom-field normalization | Company domain and API token |
| `zendesk` | `zendesk` | Zendesk ticket listing, search, comments, triage, and internal notes | Subdomain, email, and API key |

In multi-user Yoplai, credentials can be personal or shared: each user can add their own API token or Google connection (**Just me**, used only for their requests), and admins set the shared fallback (**Whole team**). Requests use the requester's own credentials first, then the team's.

Extension-specific operational documentation stays beside the owning slice or under `docs/specs/`. The authoritative host extension contract is maintained in the Yoplai repository rather than copied here.

## Usage

Build and symlink (or copy) individual built extension directories into `$YOPLAI_HOME/extensions` (`~/.yoplai/extensions` by default), or set `extensionsPath` in `yoplai.json`. `pnpm build` generates the ignored `dist/` tree and copies each available slice icon into its built directory; edit `src/`, not `dist/`.

A pre-rename install under `~/.aihub` still works, with a one-time deprecation warning, but the two kinds of fallback trigger differently:

- `YOPLAI_HOME` env var, falling back to `AIHUB_HOME` **when `YOPLAI_HOME` isn't set** (`src/mcp/index.ts`)
- `YOPLAI_WORKSPACE_DIR` env var, falling back to `AIHUB_WORKSPACE_DIR` **when `YOPLAI_WORKSPACE_DIR` isn't set** (`src/pipedrive/field-registry.ts`)
- On-disk default state paths under `~/.local/state/yoplai/extensions/...`, read from the legacy `~/.local/state/aihub/extensions/...` file only **when the new file doesn't exist yet**, for the pipedrive field-registry cache. Every write goes to the new path, so the legacy file goes inert after the first write; it can be deleted once the new file exists.

New installs should use `~/.yoplai` / `YOPLAI_*`.

```bash
pnpm install
pnpm build
mkdir -p ~/.yoplai/extensions
ln -sfn "$PWD/dist/hiveage" ~/.yoplai/extensions/hiveage
ln -sfn "$PWD/dist/pipedrive" ~/.yoplai/extensions/pipedrive
ln -sfn "$PWD/dist/pennylane" ~/.yoplai/extensions/pennylane
```

Yoplai v3 keeps agent config in each agent workspace. Root `yoplai.json` only discovers agent folders and can hold shared extension defaults.

`~/.yoplai/yoplai.json`:

```json
{
  "version": 3,
  "agents": "./agents/*"
}
```

Configure extension access in the agent folder's `agent.yaml`. Presence under `extensions` opts the agent in; `enabled: true` is optional.

`~/.yoplai/agents/sales-admin/agent.yaml`:

```yaml
id: sales-admin
name: Sales Admin
model:
  provider: anthropic
  model: claude-sonnet-4
extensions:
  pipedrive:
    apiToken: "$env:PIPEDRIVE_API_TOKEN"
    domain: "$env:PIPEDRIVE_DOMAIN"
  pennylane:
    apiToken: "$env:PENNYLANE_API_TOKEN"
  gsheets:
    serviceAccountJson: "$env:GOOGLE_SERVICE_ACCOUNT_JSON"
```

Agent-local `.env` files next to `agent.yaml` can provide those variables:

`~/.yoplai/agents/sales-admin/.env`:

```bash
PIPEDRIVE_API_TOKEN=...
PIPEDRIVE_DOMAIN=your-company-subdomain
PENNYLANE_API_TOKEN=...
GOOGLE_SERVICE_ACCOUNT_JSON={...}
```

You can still put shared defaults at the root and override or add secrets per agent.

`~/.yoplai/yoplai.json`:

```json
{
  "version": 3,
  "agents": "./agents/*",
  "extensions": {
    "pipedrive": {
      "domain": "$env:PIPEDRIVE_DOMAIN"
    },
    "hiveage": {
      "subdomain": "$env:HIVEAGE_SUBDOMAIN"
    }
  }
}
```

`~/.yoplai/agents/billing/agent.yaml`:

```yaml
id: billing
name: Billing
model:
  provider: anthropic
  model: claude-sonnet-4
extensions:
  pipedrive:
    apiToken: "$env:PIPEDRIVE_API_TOKEN"
  hiveage:
    apiKey: "$env:HIVEAGE_API_KEY"
```

To disable a shared extension for one agent:

```yaml
extensions:
  pipedrive:
    enabled: false
```
