# AIHub Tool Extensions

Self-contained agent tool packages for external APIs, used with [AIHub](https://github.com/algodyn/aihub).

## Usage

Build and symlink (or copy) individual built extension directories into `$AIHUB_HOME/extensions` (`~/.aihub/extensions` by default), or set `extensionsPath` in `aihub.json`.

```bash
pnpm install
pnpm build
mkdir -p ~/.aihub/extensions
ln -sfn "$PWD/dist/hiveage" ~/.aihub/extensions/hiveage
ln -sfn "$PWD/dist/pipedrive" ~/.aihub/extensions/pipedrive
ln -sfn "$PWD/dist/pennylane" ~/.aihub/extensions/pennylane
```

AIHub v3 keeps agent config in each agent workspace. Root `aihub.json` only discovers agent folders and can hold shared extension defaults.

`~/.aihub/aihub.json`:

```json
{
  "version": 3,
  "agents": "./agents/*"
}
```

Configure extension access in the agent folder's `agent.yaml`. Presence under `extensions` opts the agent in; `enabled: true` is optional.

`~/.aihub/agents/sales-admin/agent.yaml`:

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

`~/.aihub/agents/sales-admin/.env`:

```bash
PIPEDRIVE_API_TOKEN=...
PIPEDRIVE_DOMAIN=your-company-subdomain
PENNYLANE_API_TOKEN=...
GOOGLE_SERVICE_ACCOUNT_JSON={...}
```

You can still put shared defaults at the root and override or add secrets per agent.

`~/.aihub/aihub.json`:

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

`~/.aihub/agents/billing/agent.yaml`:

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
