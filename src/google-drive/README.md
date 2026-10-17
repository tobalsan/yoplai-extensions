# Google Drive extension

Google Drive access for an agent (read-only by default; optional file and Sheets writes), via **Google OAuth** — personal (**Just me**) or shared (**Whole team**) connections — no pasted secrets. The host resolves a fresh access token when it builds the agent's tools, or injects a clean "not connected" signal.

Tools (mounted as `googleDrive_<name>`):

- `list_files` — list files, optional name-substring filter, paginated
- `search_files` — search with Drive `q` syntax, paginated
- `sheets_list_spreadsheets` — list Google Sheets, optional name filter + pagination
- `sheets_inspect` — tabs, dimensions, detected headers
- `sheets_read_sheet` — one tab as headers + row objects (`rowOffset`, `maxRows`, `columns`)
- `sheets_read_range` — raw values for an A1 range (`majorDimension`)
- `read_file` — download by id and extract text (Google Docs/Sheets/Slides exported to text/CSV; PDF and DOCX text-extracted)
- `download_file({ fileId })` — save original bytes into the current conversation's writable folder; Google Docs/Sheets/Slides export as docx/xlsx/pptx
- `validate` — confirm the connection is live; returns the connected Google account

Read-only scopes: `drive.readonly` + `userinfo.email` (unchanged). With `allowWrite: true`, also requests `drive.file` and `spreadsheets`; no full `drive` scope. `drive.file` permits creating/editing app-created files; `spreadsheets` permits editing existing Sheets.

Write tools (only mounted when `allowWrite: true`):

- `create_folder` — name and optional parent folder id
- `save_file({ path, fileId? | name + parentId? })` — upload a local conversation file as a new copy or replace an app-accessible file while keeping its format
- `create_file` — text/CSV content, optional MIME type/parent; `convertTo: "doc" | "sheet"` creates a Google Doc or Sheet
- `update_file_content` — overwrite content (text for Docs, CSV for Sheets)
- `rename_move_file` — rename and/or add/remove parent folders
- `sheets_update_range` — A1 range and `values` row arrays; `valueInputOption` `USER_ENTERED` (default) or `RAW`

All Sheets tools accept `spreadsheetId` or `spreadsheetUrl`. Sheets reads work under `drive.readonly`; Google Sheets API must be enabled.
- `sheets_append_rows` — A1 table range and `rows` arrays; `valueInputOption` `USER_ENTERED` (default) or `RAW`

Read the target before writing, confirm when ambiguous, and report what changed. Deleting, sharing, and permissions are not exposed. Explicit OAuth scope refusals return `insufficient_scope`; download restrictions, export-size errors and file-permission refusals retain actionable Google errors. Rate limits retry twice, then return `rate_limited`.

## Work with real files

Use `read_file` for extracted text. When layout, headers, footers, logos, images or styles matter, use `download_file` → edit its returned local `path` → `save_file`. Send the edited local file to the user with `send_file` where useful.

`download_file` returns `{ fileId, name, mimeType, path, bytes }`. The host supplies a trusted `conversationFiles: { hostPath, runtimePath }` execution context, never an agent-derived shared folder. The returned path works inside the active runtime; local runtimes use the host path and containers use `/workspace/files`. Files remain private to the current conversation. Binary downloads retain exact bytes and stop at 25 MiB counted on the stream, even without Content-Length. Native exports use Google's 10 MB limit. Owner download restrictions, unsupported native types (including folders and shortcuts), cancellation and timeout leave no partial file. Shared-drive metadata and media requests use `supportsAllDrives=true`.

`save_file` accepts an absolute runtime path (or a host path inside the same conversation folder), rejects path escapes and symlinks pointing outside, and returns `{ fileId, name, mimeType, webViewLink }`. Save regular files directly in the conversation folder root; nested paths are rejected to prevent mutable ancestor symlinks from escaping the folder. Without `fileId`, supply `name` and optionally `parentId` to create a binary file in its local format. With `fileId`, omit `name` and `parentId`: binary formats stay binary and native Docs/Sheets/Slides import the matching docx/xlsx/pptx back into the original native file. A mismatched replacement format is rejected.

Google documents that [Office upload conversion during an update replaces the complete contents of an existing Google Doc, Sheet or Slide](https://developers.google.com/workspace/drive/api/guides/manage-uploads#convert_to_google_docs_types). Multipart uploads use Office media Content-Type and the target's existing native MIME type in metadata. Actual Google conversion and fidelity must also be verified against a connected test account.

The approved scope remains `drive.file`, not full `drive`. Creating copies works; replacing arbitrary user-owned files does not. Replace only files the app created or the user explicitly authorized for this app. A Google Sheets grant alone does not authorize a Drive media replacement of an arbitrary existing Sheet. For Frederic's template, download the original docx, edit only its body, and save a new docx copy.

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

Opt in under `extensions` in the agent's `agent.yaml`. The token is injected by the host. `allowWrite` defaults to false; enable it with the toggle on the agent extension page, then reconnect Google to approve write scopes.

`~/.yoplai/agents/<agent>/agent.yaml`:

```yaml
extensions:
  googleDrive:
    allowWrite: true       # omit or false for read-only
```

Root `extensions.googleDrive.allowWrite` sets the shared default; an agent's explicit `allowWrite` overrides it (including `false`).

## 3. Operator: register a Google OAuth client (one-time, in GCP)

In the [Google Cloud Console](https://console.cloud.google.com/):

1. **Enable the Google Drive API** (and Google Sheets API for write mode) (APIs & Services → Library).
2. **OAuth consent screen** — add `.../auth/drive.readonly` and `userinfo.email`; write mode also needs `.../auth/drive.file` and `.../auth/spreadsheets`.
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

- **Insufficient scope** (e.g. write mode enabled after a read-only grant) → reconnect and approve the configured scopes. The reconnect URL requests those scopes.
- **Needs reconnect** (grant revoked/expired-beyond-refresh) → click **Reconnect**.
- **Disconnect** revokes and clears the grant.

Until connected, every tool returns a documented not-connected signal (never a raw 401), and the agent should tell the user to connect rather than guessing credentials.

---

## Verify

Run `googleDrive_validate` from the agent — a healthy connection returns `connected: true` with the Google account and scopes.

Operator reference (host repo): `yoplai/docs/oauth-google-drive-setup.md`.


## Human OAuth verification checklist

Use the external-testing Google OAuth app (no agent-driven OAuth E2E):

1. Confirm read-only mode lists/reads files and exposes no writes; enable and save `allowWrite` on the agent page, then reconnect with the write scopes.
2. Create a Sheet with `create_file` (`convertTo: "sheet"`), append rows, and update an A1 range, including a pre-existing Sheet.
3. Read the result, rename/move the file, and confirm the reported changes in Drive.
4. Confirm Gmail tools still work on the same Google connection after Drive reconnect (Google incremental consent preserves prior grants).
5. Confirm an agent `allowWrite: false` overrides a root `true` default and hides write tools.

Requires the platform release with config-dependent OAuth requirements; land platform first.
