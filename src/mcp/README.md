# MCP extension

Connect an Yoplai agent to standard MCP servers declared in its `mcp.json`. Exposed tools are named `mcp__<server>__<tool>` (non-alphanumeric characters become `_`).

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/mcp" ~/.yoplai/extensions/mcp
```

## Enable an agent

MCP requires explicit opt-in with `enabled: true`.

`~/.yoplai/agents/research/agent.yaml`:

```yaml
id: research
name: Research
extensions:
  mcp:
    enabled: true
```

By default, the extension loads `mcp.json` from the agent directory.

## Configure servers

`~/.yoplai/agents/research/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "docs": {
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer ${DOCS_MCP_TOKEN}"
      }
    }
  }
}
```

Use `command` for stdio servers, or `url` for HTTP/SSE servers. URLs ending in `/sse` use SSE; other HTTP URLs use Streamable HTTP.

Environment variables in `mcp.json` use `${NAME}` syntax. Put agent-specific values in the adjacent `.env` file:

```bash
DOCS_MCP_TOKEN=...
```

The extension also reads process environment, root `env`, and `$YOPLAI_HOME/.env` (agent `.env` takes precedence).

## Custom location

Set `configPath` or `agentDir` when the defaults do not fit:

```yaml
extensions:
  mcp:
    enabled: true
    configPath: /srv/yoplai/mcp/research.json
```

Unavailable or invalid servers are logged and skipped; tools from healthy servers remain available.

## OAuth servers

For an OAuth-protected remote MCP server such as Claap, configure only its URL:

```json
{ "mcpServers": { "claap": { "url": "https://api.claap.io/mcp" } } }
```

Open the agent's MCP extension settings and connect Claap. The extension discovers the OAuth server, dynamically registers a client, and stores the per-agent connection under its data directory with restrictive permissions.

Set `BASE_URL` to the public gateway origin so the OAuth provider can return to the gateway. Top-level `env` in `yoplai.json` is sufficient; do not include an `/api` suffix:

```json
{
  "env": {
    "BASE_URL": "https://yoplai.example.com"
  }
}
```

The callback becomes `${BASE_URL}/api/mcp/oauth/callback`. Without this variable, the extension falls back to `server.baseUrl` from `yoplai.json`, then to `http://localhost:4000`. Restart the gateway after changing it.

Use a public (non-localhost) origin whenever possible: some providers sit behind a WAF that rejects `localhost` / `127.0.0.1` redirect URIs outright (TradingView's CloudFront returns a 403 on the sign-in page), so the default only works for providers that tolerate loopback callbacks.

Claap can instead use a workspace API key, which remains the unchanged static-header path:

```json
{ "mcpServers": { "claap": { "url": "https://api.claap.io/mcp", "headers": { "Authorization": "Bearer ${CLAAP_API_KEY}" } } } }
```
