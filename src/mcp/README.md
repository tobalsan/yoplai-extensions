# MCP extension

Connect an Yoplai agent to standard MCP servers declared in its `mcp.json`. Exposed tools are named `mcp__<server>__<tool>` (non-alphanumeric characters become `_`).

The agent's **My connections** tab lists your personal MCP OAuth connections and team availability. Disconnect deletes your credential immediately; the next request uses the team connection or asks you to connect. Provider revocation runs separately and cannot delay local removal.

## MCP Apps

Tool-serving connections always advertise the stable UI extension, `io.modelcontextprotocol/ui`, with `mimeTypes: ["text/html;profile=mcp-app"]`. The account-label client does not advertise it. No extra server configuration is needed. Older platforms ignore the additive fields and continue receiving raw tool results; a UI-aware server may choose its UI variant and must retain meaningful text.

Discovery preserves tool `_meta`. A view uses `_meta.ui.resourceUri`, falling back to deprecated `_meta["ui/resourceUri"]`; only a valid `ui://` URI identifies a view. Visibility is separate: absent `_meta.ui.visibility` means `["model", "app"]`; malformed visibility permits only `"model"`. App-only helpers remain hidden even without a valid view. The full catalog is adapted before model filtering, preserving existing names and collision suffixes. Model tools carry `mcp: { server, tool, ui? }` with configured server and raw upstream tool names. This filters every model path fed by this extension, including deferred tools, tool search, codemode and container inventories. The platform's separate `capabilities.list` discovery requires ALG-544.

The extension's optional host interface mirrors ALG-544 without importing platform types:

```ts
mcpApps.readResource({ agentId, userId?, signal? }, server, uri)
  // Promise<{ contents: { uri, mimeType?, text?, blob?, _meta? }[] }>
mcpApps.callTool({ agentId, userId?, signal? }, server, tool, args)
  // Promise<Record<string, unknown>> — raw CallToolResult
```

Both operations resolve the current agent configuration and use the viewer's personal OAuth grant, or team grant when no personal grant exists. A personal grant requiring reconnect refuses without team fallback. Only enabled servers are reachable; resource requests go to the named server. App calls resolve the raw tool name in that server's current private catalog and require `"app"` visibility, including for tools without a view. There is no public catalog-list operation.

One total deadline covers credentials/refresh, connection, catalog listing, auth recovery and request: 10 seconds for reads, 25 seconds for calls. Abort rejects immediately. No subsequent call or retry starts after abort/deadline; late connections close in the background. Cleanup never delays rejection. Raw resource contents, including CSP metadata, and raw tool results, including `structuredContent`, `_meta` and upstream `isError: true`, pass through unchanged.

Host-side failures reject with `name: "McpAppsError"` and a string `reason`: `unknown_agent`, `unknown_server`, `unknown_tool`, `not_app_visible`, `not_connected`, `needs_reconnect`, `timeout`, `aborted` or `upstream`. Connection refusals include `authorizeUrl` when available. Upstream JSON-RPC failures reject as `upstream`; tool results with `isError: true` resolve normally.

This slice provides MCP facts and operations only. HTML/CSP validation, resource caching, web view hosting, capture/history and relay routes belong to the platform; deploy this extension with or before ALG-544.

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/mcp" ~/.yoplai/extensions/mcp
```

## Enable an agent

MCP is available automatically when the agent directory contains `mcp.json` or the shared catalog (below) is non-empty; an `enabled` flag is not required. Without either, no MCP tools or server cards appear. By default, the extension loads `mcp.json` from the agent directory.

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

The agent's extension list at `/agents/<agent-id>/edit` shows every configured MCP server as its own card. **Add custom extension** accepts an HTTP(S) URL and **Just me** or **Whole team**; a detected OAuth server starts authorization immediately, unless **Just me** is chosen and you already have a usable personal connection for that URL from another agent. A server without OAuth is connected directly. Existing stdio and hand-configured HTTP servers also appear as cards with their configuration read-only. **Disconnect** deletes the selected OAuth credential but keeps the server; **Remove** deletes the server from the shared `mcp.json` for everyone, after confirmation in the UI. HTTP servers without a server-provided icon get the website icon of their host, then of its root domain (e.g. `api.claap.io` → `claap.io`); hits are cached in `<YOPLAI_HOME>/mcp/icons.json`. Servers added from the UI get a readable key from their site (`mcp.linear.app` → `linear`, then `linear_2`), and cards show the server-reported name and description (`serverInfo.title`/`description`; sentence-like titles are split at the first colon or dash) once connected, saved as `displayName`/`description` on UI-added `mcp.json` entries. Any server entry, stdio included, may set optional `displayName` and `description` to override the card label (yoplai-only keys; other MCP clients ignore them). A small built-in table labels hosted servers whose serverInfo is generic (`calendarmcp.googleapis.com` → Google Calendar with its icon); `displayName` still wins. Servers without an icon show the official MCP logo. Missing app icons use the generic MCP icon. Tool refusals link back to that agent edit page.

`GET /mcp/servers/personal-status?agent=&url=` returns `{ connected }`: true only when the signed-in user already has a usable personal grant for that URL (shared from another agent), so the UI can skip authorization when adding the server "Just me".

`GET /mcp/servers?agent=&live=0` returns all card metadata immediately, with `state: "disconnected"` and `status: "pending"`, using stored labels, account labels, grant states and cached icons only. It makes no network calls. A requester’s personal grant, team or legacy grant, explicit OAuth configuration, or earlier OAuth detection preserves the OAuth UI even when a server is offline. Shared catalog cards follow the same rules, including disabled entries and their saved server titles.

`GET /mcp/servers?agent=&server=` checks one named server with a single 10-second deadline covering token refresh, connection and tool listing. It makes no OAuth probe or second connection attempt; cached icons and stored account labels avoid extra lookups, and cleanup runs in the background. Network failures and timeouts return `state: "unreachable"`; protocol/configuration failures return `disconnected` with `error`, and authentication failures requiring a new grant return `needs_reconnect`. Missing OAuth grants remain disconnected. Transient refresh failures and late refresh responses leave stored grants unchanged; only authentication failures mark the selected grant for reconnect. A successful connection with no tools is connected. Unreachable results are not cached, so Retry makes a fresh attempt.

Both modes filter on `server` before building cards; unknown names return an empty `servers` list with the usual permissions envelope. `server=&live=0` returns one fast card. Omitting both options keeps the full live list behavior; runtime tool connections and add-server OAuth discovery keep their existing policies.

Settings connections pass `returnTo` to `GET /mcp/oauth/authorize`, or in the JSON body of `POST /mcp/servers`. Only same-site paths without control characters or backslashes are accepted. Scope selection preserves the path. After OAuth, the callback redirects there with `oauth=connected|error`, `oauth_scope=personal|team`, and `oauth_error` on failure, preserving existing query values and fragments. Missing, expired, or unknown flows and callers without a safe return path retain the popup result page; chat and Slack links keep that behavior.

Each card opens a config page. OAuth servers offer the usual Just me / Whole team connect, reconnect and disconnect. Other HTTP servers offer a JSON editor for their entry in `mcp.json`, backed by `GET/POST /mcp/servers/config?agent=&server=`: it is team-wide, requires the same authentication as the other server routes, validates the HTTP schema (`url` must be http/https without credentials; `command`/`args`/`env` are rejected), keeps other servers and unknown file fields, resets MCP managers and records `mcp.server.update`. Header values, `env` values and `oauth.clientSecret` are returned as `••••••••`; a submitted mask keeps the stored value. stdio servers are shown read-only because editing them would allow command execution.

The extension discovers OAuth servers, dynamically registers clients, and stores connections in the host's shared encrypted credential store (`ctx.credentials`). Tool execution resolves the authenticated requester's personal connection first, then the team connection; unattended runs use team only. Personal connections follow the user across agents for the same server URL (plus static `oauth.clientId`, regardless of the `mcp.json` key), so connecting once covers every agent that configures that server; team connections remain per agent. A personal connection needing reconnect never falls back to another account. Existing per-agent OAuth files migrate as team connections after encrypted persistence succeeds; files remain readable until encryption is configured. New authorizations require the host credential store. Status and disconnect target the selected scope, and refresh/reconnect are isolated per credential. An agent member with access may select either scope.

**Connected as.** After connecting, the extension makes a best-effort, 5-second-bounded lookup of the account behind each connection, stores it as `account` on the credential (never the token), and shows "Connected as <account>" on the server page (`personalAccount`/`teamAccount` in `GET /mcp/servers`, `account` in `GET /mcp/oauth/status`). Order: `id_token` claims (`email`, else `name`/`preferred_username`); an `email` claim in a JWT access token; the authorization server's OIDC `userinfo_endpoint`; a built-in table by MCP host (`mcp.pipedrive.ai` → REST `api.pipedrive.com/api/v1/users/me`, `mcp.notion.com` → tool `notion-get-users {user_id:"self"}`, `mcp.linear.app` → tool `get_user {query:"me"}`); then, for any server, a read-only whoami-style tool (`whoami`, `me`, `get_current_user`, `userinfo`, `viewer`, …) that takes no required arguments. Failures just leave the label out. Connections made before this feature are looked up once per process when status is read.

Servers that answer an unauthenticated `initialize` with 200 are still treated as OAuth when their RFC 9728 protected-resource metadata (`/.well-known/oauth-protected-resource<path>`, then the root) lists `authorization_servers`. The client is chosen in this order: per-server `oauth` in `mcp.json`; dynamic registration when the authorization server offers it; otherwise the host `oauth.providers.<name>` entry for a known issuer (`accounts.google.com` → `google`, `mcp.hubspot.com` → `hubspot`). Without any of these, connecting fails with an error naming the missing setting. All clients request the server's `scopes_supported` unless `oauth.scopes` is set. Pre-registered clients also send `access_type=offline` and `prompt=consent` for refresh tokens. Example: Google Calendar (`https://calendarmcp.googleapis.com/mcp/v1`) needs only `oauth.providers.google.{clientId,clientSecret}` in `yoplai.json`, with `${BASE_URL}/api/mcp/oauth/callback` registered as an authorized redirect URI on that Google client.

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

## Shared server catalog

Superadmins manage a host-wide catalog in `<YOPLAI_HOME>/mcp.json` (same `{ "mcpServers": {...} }` shape, HTTP servers only) from the admin **MCP servers** tab: `GET/POST /mcp/catalog`, `POST /mcp/catalog/update?server=` (displayName/description) and `POST /mcp/catalog/remove?server=`. Plain admins get 403; `command`/`args`/`env` are rejected; keys are derived from the URL like UI-added servers (`linear`, `linear_2`). Audit uses `mcp.server.add|update|remove`. Removing a server stops it on every agent; stale keys in agent files are ignored. There is no OAuth connection from the admin page.

Every agent lists catalog servers on its extensions page, even without its own `mcp.json`, as cards with `shared: true` and `enabled`. They are **off by default**: no connection is started and no tools are exposed until a member enables one (`POST /mcp/servers/shared?agent=&server=` with `{ "enabled": true|false }`), which records the key in the yoplai-only `"sharedServers": ["linear"]` field of the agent's `mcp.json` (created if missing; other fields are preserved; audit `mcp.server.enable|disable`). Enabled servers behave like local ones, including Just me / Whole team OAuth; team grants stay per agent and server key. A local entry with the same key or the same URL wins and hides the catalog entry for that agent, so existing grants are untouched. Agent cards offer Enable/Disable (not Remove) for shared servers.

## Label overrides

`displayName` and `description` set manually always win over server-reported `serverInfo` and the built-in host table, and automatic label saving never overwrites them. Superadmins can set or clear them for any local server (including OAuth and stdio; labels only) from a collapsed "Edit MCP details" section on the server page, backed by `POST /mcp/servers/label?agent=&server=` and `{ displayName?, description? }` (trimmed, capped at 100/500 characters; empty removes the field so the server-reported label is used again; audit `mcp.server.update`). Catalog servers are labeled on the admin page and shared cards use those labels.

## Personal connections from Slack

On hosts exposing `ctx.credentialConnect`, missing or unusable MCP credentials return the requester’s single connect link. The host verifies Slack ownership and pairs if needed before invoking MCP authorization; the grant is always **Just me**. MCP uses the trusted `mcpServers` configuration key (`server.name`) as the hook’s `targetId`, binds it and the personal owner to expiring CSRF/PKCE state, and confirms the original thread only after storing the grant. Provider denial, exchange failure, invalid/expired state, and replay never confirm. Existing team connections and hosts without the hook keep their normal behavior.

This uses the context hook introduced by platform ALG-458 (PR #129, commit `2c56a866`); it does not import or bundle `@yoplai/shared`. Live Slack and Claap consent must be verified in a real workspace after deployment.

## Cancellation

MCP tool calls forward the gateway's cancellation signal to the MCP client, including OAuth refresh retries. Cancellation is cooperative: a timeout does not prove that a remote side effect did not happen.
