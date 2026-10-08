# MCP extension

Connect an Yoplai agent to standard MCP servers declared in its `mcp.json`. Exposed tools are named `mcp__<server>__<tool>` (non-alphanumeric characters become `_`).

The agent's **My connections** tab lists your personal MCP OAuth connections and team availability. Disconnect deletes your credential immediately; the next request uses the team connection or asks you to connect. Provider revocation runs separately and cannot delay local removal.

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/mcp" ~/.yoplai/extensions/mcp
```

## Enable an agent

MCP is available automatically when the agent directory contains `mcp.json`; an `enabled` flag is not required. Without that file, no MCP tools or server cards appear. By default, the extension loads `mcp.json` from the agent directory.

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
    configPath: /srv/yoplai/mcp/research.json
```

Unavailable or invalid servers are logged and skipped; tools from healthy servers remain available.

## OAuth servers

For an OAuth-protected remote MCP server such as Claap, configure only its URL:

```json
{ "mcpServers": { "claap": { "url": "https://api.claap.io/mcp" } } }
```

The agent's extension list at `/agents/<agent-id>/edit` shows every configured MCP server as its own card. **Add custom extension** accepts an HTTP(S) URL and **Just me** or **Whole team**; a detected OAuth server starts authorization immediately, unless **Just me** is chosen and you already have a usable personal connection for that URL from another agent. A server without OAuth is connected directly. Existing stdio and hand-configured HTTP servers also appear as cards with their configuration read-only. **Disconnect** deletes the selected OAuth credential but keeps the server; **Remove** deletes the server from the shared `mcp.json` for everyone, after confirmation in the UI. HTTP servers without a server-provided icon get the website icon of their host, then of its root domain (e.g. `api.claap.io` → `claap.io`); hits are cached in `<YOPLAI_HOME>/mcp/icons.json`. Servers added from the UI get a readable key from their site (`mcp.linear.app` → `linear`, then `linear_2`), and cards show the server-reported name and description (`serverInfo.title`/`description`; sentence-like titles are split at the first colon or dash) once connected, saved as `displayName`/`description` on UI-added `mcp.json` entries. Any server entry, stdio included, may set optional `displayName` and `description` to override the card label (yoplai-only keys; other MCP clients ignore them). Servers without an icon show the official MCP logo. Missing app icons use the generic MCP icon. Tool refusals link back to that agent edit page.

`GET /mcp/servers/personal-status?agent=&url=` returns `{ connected }`: true only when the signed-in user already has a usable personal grant for that URL (shared from another agent), so the UI can skip the OAuth popup when adding the server "Just me".

Each card opens a config page. OAuth servers offer the usual Just me / Whole team connect, reconnect and disconnect. Other HTTP servers offer a JSON editor for their entry in `mcp.json`, backed by `GET/POST /mcp/servers/config?agent=&server=`: it is team-wide, requires the same authentication as the other server routes, validates the HTTP schema (`url` must be http/https without credentials; `command`/`args`/`env` are rejected), keeps other servers and unknown file fields, resets MCP managers and records `mcp.server.update`. Header values, `env` values and `oauth.clientSecret` are returned as `••••••••`; a submitted mask keeps the stored value. stdio servers are shown read-only because editing them would allow command execution.

The extension discovers OAuth servers, dynamically registers clients, and stores connections in the host's shared encrypted credential store (`ctx.credentials`). Tool execution resolves the authenticated requester's personal connection first, then the team connection; unattended runs use team only. Personal connections follow the user across agents for the same server URL (plus static `oauth.clientId`, regardless of the `mcp.json` key), so connecting once covers every agent that configures that server; team connections remain per agent. A personal connection needing reconnect never falls back to another account. Existing per-agent OAuth files migrate as team connections after encrypted persistence succeeds; files remain readable until encryption is configured. New authorizations require the host credential store. Status and disconnect target the selected scope, and refresh/reconnect are isolated per credential. An agent member with access may select either scope.

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

## Personal connections from Slack

On hosts exposing `ctx.credentialConnect`, missing or unusable MCP credentials return the requester’s single connect link. The host verifies Slack ownership and pairs if needed before invoking MCP authorization; the grant is always **Just me**. MCP uses the trusted `mcpServers` configuration key (`server.name`) as the hook’s `targetId`, binds it and the personal owner to expiring CSRF/PKCE state, and confirms the original thread only after storing the grant. Provider denial, exchange failure, invalid/expired state, and replay never confirm. Existing team connections and hosts without the hook keep their normal behavior.

This uses the context hook introduced by platform ALG-458 (PR #129, commit `2c56a866`); it does not import or bundle `@yoplai/shared`. Live Slack and Claap consent must be verified in a real workspace after deployment.
