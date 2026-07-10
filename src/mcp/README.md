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
