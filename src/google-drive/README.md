# Google Drive extension

Read-only Google Drive access for an agent, via **Google OAuth** — personal (**Just me**) or shared (**Whole team**) connections — no pasted secrets. The host resolves a fresh access token when it builds the agent's tools, or injects a clean "not connected" signal.

Tools (mounted as `googleDrive_<name>`):

- `list_files` — list files, optional name-substring filter, paginated
- `search_files` — search with Drive `q` syntax, paginated
- `read_file` — download by id and extract text (Google Docs/Sheets/Slides exported to text/CSV; PDF and DOCX text-extracted)
- `validate` — confirm the connection is live; returns the connected Google account

Scopes requested: `drive.readonly` + `userinfo.email`. Read-only, no mutations.

---

## How it differs from other extensions

Unlike `gsheets`/`pipedrive`/etc., **no credential goes in the extension config**. The Google app credentials live host-side in Yoplai's OAuth framework; the agent config only *opts in*. Setup is two parts: **operator** (register a Google OAuth client + configure Yoplai once) and **user** (click Connect).

---

## 1. Build & install the extension

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/google-drive" ~/.yoplai/extensions/google-drive
```

## 2. Enable it for an agent

Opt in under `extensions` in the agent's `agent.yaml`. Config is empty — the token is injected by the host, not read from here.

`~/.yoplai/agents/<agent>/agent.yaml`:

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

Actual secrets in `$YOPLAI_HOME/.env` (env var names are your choice — just match the `$env:` refs):

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
OAUTH_ENCRYPTION_KEY=<random 32-byte secret>
```

Notes:
- `oauth.encryptionKey` encrypts tokens at rest (AES-256-GCM). **Fail-closed:** without it the host refuses to persist tokens.
- Each connection is either **Just me** (personal: used only for that user's requests) or **Whole team** (shared fallback for everyone on the agent). Tool calls use the requester's personal connection first, then the team connection; another user's personal connection is never used. Only admins can change the Whole team connection.

## 5. User: connect

In the Yoplai web UI, open the agent's **Google Drive** extension page (or the agent's **My connections** tab), pick the **Just me** or **Whole team** tab, and click **Connect**. This opens Google's consent screen; on return the state shows **Connected as `<email>`**.

- **Needs reconnect** (grant revoked/expired-beyond-refresh) → click **Reconnect**.
- **Disconnect** revokes and clears the grant.

Until connected, every tool returns a documented not-connected signal (never a raw 401), and the agent should tell the user to connect rather than guessing credentials.

---

## Verify

Run `googleDrive_validate` from the agent — a healthy connection returns `connected: true` with the Google account and scopes.

Operator reference (host repo): `yoplai/docs/oauth-google-drive-setup.md`.
