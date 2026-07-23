# MCP extension

Connect an AIHub agent to standard MCP servers declared in its `mcp.json`. Exposed tools are named `mcp__<server>__<tool>` (non-alphanumeric characters become `_`).

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/mcp" ~/.aihub/extensions/mcp
```

## Enable an agent

MCP requires explicit opt-in with `enabled: true`.

`~/.aihub/agents/research/agent.yaml`:

```yaml
id: research
name: Research
extensions:
  mcp:
    enabled: true
```

By default, the extension loads `mcp.json` from the agent directory.

## Configure servers

`~/.aihub/agents/research/mcp.json`:

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

The extension also reads process environment, root `env`, and `$AIHUB_HOME/.env` (agent `.env` takes precedence).

## Custom location

Set `configPath` or `agentDir` when the defaults do not fit:

```yaml
extensions:
  mcp:
    enabled: true
    configPath: /srv/aihub/mcp/research.json
```

Unavailable or invalid servers are logged and skipped; tools from healthy servers remain available.

## OAuth servers

For an OAuth-protected remote MCP server such as Claap, configure only its URL:

```json
{ "mcpServers": { "claap": { "url": "https://api.claap.io/mcp" } } }
```

Open the agent's MCP extension settings and connect Claap. The extension discovers the OAuth server, dynamically registers a client, and stores the per-agent connection under its data directory with restrictive permissions. The callback is `${AIHUB_BASE_URL}/api/mcp/oauth/callback` (or `http://localhost:4000` when unset).

Claap can instead use a workspace API key, which remains the unchanged static-header path:

```json
{ "mcpServers": { "claap": { "url": "https://api.claap.io/mcp", "headers": { "Authorization": "Bearer ${CLAAP_API_KEY}" } } } }
```
