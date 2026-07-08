# Google Drive extension

Read-only Google Drive access for an agent, via **per-agent OAuth** — no pasted secrets. The agent gets an always-fresh access token at tool-run time, or a clean "not connected" signal.

Tools (mounted as `googleDrive_<name>`):

- `list_files` — list files, optional name-substring filter, paginated
- `search_files` — search with Drive `q` syntax, paginated
- `read_file` — download by id and extract text (Google Docs/Sheets/Slides exported to text/CSV; PDF and DOCX text-extracted)
- `validate` — confirm the connection is live; returns the connected Google account

Scopes requested: `drive.readonly` + `userinfo.email`. Read-only, no mutations.

---

## How it differs from other extensions

Unlike `gsheets`/`pipedrive`/etc., **no credential goes in the extension config**. The Google app credentials live host-side in AIHub's OAuth framework; the agent config only *opts in*. Setup is two parts: **operator** (register a Google OAuth client + configure AIHub once) and **user** (click Connect).

---

## 1. Build & install the extension

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/google-drive" ~/.aihub/extensions/google-drive
```

## 2. Enable it for an agent

Opt in under `extensions` in the agent's `agent.yaml`. Config is empty — the token is injected by the host, not read from here.

`~/.aihub/agents/<agent>/agent.yaml`:

```yaml
extensions:
  googleDrive: {}          # presence opts in; enabled: true is optional
```

## 3. Operator: register a Google OAuth client (one-time, in GCP)

In the [Google Cloud Console](https://console.cloud.google.com/):

1. **Enable the Google Drive API** (APIs & Services → Library).
2. **OAuth consent screen** — add the scope `.../auth/drive.readonly` (and `userinfo.email`).
3. **Credentials → Create OAuth client ID → Web application.**
4. Under **Authorized redirect URIs**, add — byte-for-byte, per deployment:

   ```
   <oauth.redirectBaseUrl>/api/oauth/google/callback
   ```

   Base defaults to `http://localhost:4000` if unset. Any mismatch → `redirect_uri_mismatch`.
5. Copy the generated **client ID** and **client secret**.

## 4. Operator: configure AIHub (host `aihub.json`)

Google credentials go under a top-level `oauth` key in `aihub.json` (BYO — bring-your-own client). `$env:` refs are supported and recommended.

`~/.aihub/aihub.json`:

```jsonc
{
  "version": 3,
  "agents": "./agents/*",
  "oauth": {
    "redirectBaseUrl": "https://aihub.example.com",
    "providers": {
      "google": {
        "clientId": "$env:GOOGLE_CLIENT_ID",
        "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
      }
    },
    "encryptionKey": "$env:AIHUB_OAUTH_ENCRYPTION_KEY"
  }
}
```

Actual secrets in `$AIHUB_HOME/.env` (env var names are your choice — just match the `$env:` refs):

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
AIHUB_OAUTH_ENCRYPTION_KEY=<random 32-byte secret>
```

Notes:
- `oauth.encryptionKey` encrypts tokens at rest (AES-256-GCM). **Fail-closed:** without it the host refuses to persist tokens.
- Connection is owned per **agent/workspace** (single shared grant), not per user.

## 5. User: connect

In the AIHub web UI, open **`/connections`** for the agent and click **Connect Google Drive**. This opens Google's consent screen; on return the state shows **Connected as `<email>`**.

- **Needs reconnect** (grant revoked/expired-beyond-refresh) → click **Reconnect**.
- **Disconnect** revokes and clears the grant.

Until connected, every tool returns a documented not-connected signal (never a raw 401), and the agent should tell the user to connect rather than guessing credentials.

---

## Verify

Run `googleDrive_validate` from the agent — a healthy connection returns `connected: true` with the Google account and scopes.

Operator reference (host repo): `aihub/docs/oauth-google-drive-setup.md`.
