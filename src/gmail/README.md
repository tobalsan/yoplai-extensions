# Gmail extension

Gmail mailbox tools for an agent, via **per-agent OAuth** — no pasted secrets. The host supplies a fresh Google OAuth token when building the agent's tools; this extension stores neither tokens nor mailbox data.

Tools (mounted as `gmail_<name>`), the Google Gmail MCP's current ten-tool surface:

- `create_draft` — create an email draft without sending it (supports `to`/`cc`/`bcc`, text or HTML body, `replyToMessageId`)
- `update_draft` — update an existing draft by Draft ID; omitted fields keep current values (HTML body dropped unless resent)
- `delete_draft` — permanently delete a draft by Draft ID
- `list_drafts` — list drafts, paginated, optional Gmail query
- `get_thread` — get a thread and its messages (`MINIMAL` or `FULL_CONTENT`)
- `search_threads` — search threads with Gmail query syntax, paginated, optional `includeTrash`
- `label_thread` / `unlabel_thread` — add/remove labels on a thread
- `label_message` / `unlabel_message` — add/remove labels on a message
- `list_labels` — list user-defined labels, paginated
- `create_label` — create a label, optional colors

Scopes requested: `gmail.modify` + `userinfo.email`. No send, no delete, no settings access.

Every successful result includes `account`, the connected mailbox identity.

## How OAuth works

Same model as the Google Drive extension: **no credential goes in the extension config**. The Google app credentials live host-side in Yoplai's OAuth framework; the agent config only *opts in*. Setup is two parts: **operator** (register a Google OAuth client + configure Yoplai once) and **user** (click Connect).

Each time the host builds the agent's tools, it injects a freshly resolved access token. Until connected — or when the grant expires, lacks scope, or is rate limited — tools return a documented not-connected signal (never a raw 401):

| `reason` | Meaning | Fix |
| --- | --- | --- |
| `not_connected` | No grant yet | Connect Google in settings (an `authorizeUrl` is included when available) |
| `expired` | Grant expired beyond refresh | Reconnect |
| `insufficient_scope` | Gmail scope not approved | Reconnect and approve Gmail access |
| `wrong_account` | Mailbox ≠ connected Google account | Reconnect the intended account |
| `rate_limited` | Gmail quota hit | Wait and retry |

## 1. Build & install the extension

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/gmail" ~/.yoplai/extensions/gmail
```

## 2. Enable it for an agent

Opt in under `extensions` in the agent's `agent.yaml`. Config is empty — the token is injected by the host, not read from here.

`~/.yoplai/agents/<agent>/agent.yaml`:

```yaml
extensions:
  gmail: {}                # presence opts in; enabled: true is optional
```

A fuller example alongside other extensions:

```yaml
name: mail-triage
model: claude-sonnet-5
extensions:
  gmail: {}                # per-agent OAuth — nothing else to configure here
  googleDrive: {}
```

## 3. Operator: register a Google OAuth client (one-time, in GCP)

In the [Google Cloud Console](https://console.cloud.google.com/):

1. **Enable the Gmail API** (APIs & Services → Library).
2. **OAuth consent screen** — add the scopes `.../auth/gmail.modify` and `userinfo.email`.
3. **Credentials → Create OAuth client ID → Web application.**
4. Under **Authorized redirect URIs**, add — byte-for-byte, per deployment:

   ```
   <oauth.redirectBaseUrl>/api/oauth/google/callback
   ```

   Base defaults to `http://localhost:4000` if unset. Any mismatch → `redirect_uri_mismatch`.
5. Copy the generated **client ID** and **client secret**.

Already set up Google OAuth for the Google Drive extension? Reuse the same client — just add the Gmail API + scopes to it; steps 4–5 below are then already done.

## 4. Operator: configure Yoplai (host `yoplai.json`)

Google credentials go under a top-level `oauth` key in `yoplai.json` (BYO — bring-your-own client). `$env:` refs are supported and recommended.

`~/.yoplai/yoplai.json`:

```jsonc
{
  "version": 3,
  "agents": "./agents/*",
  "oauth": {
    "redirectBaseUrl": "https://yoplai.example.com",
    "providers": {
      "google": {
        "clientId": "$env:GOOGLE_CLIENT_ID",
        "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
      }
    },
    "encryptionKey": "$env:OAUTH_ENCRYPTION_KEY"
  }
}
```

Actual secrets in `$YOPLAI_HOME/.env`:

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
OAUTH_ENCRYPTION_KEY=<random 32-byte secret>
```

Notes:
- `oauth.encryptionKey` encrypts tokens at rest (AES-256-GCM). **Fail-closed:** without it the host refuses to persist tokens.
- Connection is owned per **agent/workspace** (single shared grant), not per user.

## 5. User: connect

In the Yoplai web UI, open **`/connections`** for the agent and click **Connect Google**. This opens Google's consent screen; on return the state shows **Connected as `<email>`**.

- **Needs reconnect** (grant revoked/expired-beyond-refresh) → click **Reconnect**.
- **Disconnect** revokes and clears the grant.

---

## Behavior notes

- `list_drafts` normally returns Gmail Draft resource IDs. Gmail's REST drafts endpoint cannot filter by query; when `query` is provided, the extension searches `in:draft` messages with Gmail query syntax instead. In that response, `draftIdKind` is `"message"` and each `id` is a Gmail message ID.
- `list_labels` returns user-defined labels only, as the Gmail MCP contract does. Gmail system label IDs such as `INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, and `IMPORTANT` remain valid inputs for label mutation tools.

Operator reference (host repo): `yoplai/docs/oauth-google-drive-setup.md` (same Google OAuth framework).
