# Yoplai Tool Extensions

Self-contained agent tool packages for external APIs, used with [Yoplai](https://github.com/algodyn/yoplai).

## Usage

Build and symlink (or copy) individual built extension directories into `$YOPLAI_HOME/extensions` (`~/.yoplai/extensions` by default), or set `extensionsPath` in `yoplai.json`.

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
