# Google Drive extension

Google Drive access for an agent (read-only by default; optional file, Sheets and Slides writes), via **Google OAuth** — personal (**Just me**) or shared (**Whole team**) connections — no pasted secrets. The host resolves a fresh access token when it builds the agent's tools, or injects a clean "not connected" signal.

Tools (mounted as `googleDrive_<name>`):

- `list_files` — list files, optional name-substring filter, paginated
- `search_files` — search with Drive `q` syntax, paginated
- `sheets_list_spreadsheets` — list Google Sheets, optional name filter + pagination
- `sheets_inspect` — tabs, dimensions, detected headers
- `sheets_read_sheet` — one tab as headers + row objects (`rowOffset`, `maxRows`, `columns`)
- `sheets_read_range` — raw values for an A1 range (`majorDimension`)
- `read_file` — download by id and extract text (Google Docs/Sheets/Slides exported to text/CSV; PDF, DOCX and PPTX text-extracted, with slide numbers and notes for PPTX)
- `download_file({ fileId, format?: "office" | "pdf" })` — save original bytes into the current conversation's writable folder; Google Docs/Sheets/Slides export as docx/xlsx/pptx by default, or PDF
- `slides_get({ presentationId? | presentationUrl?, slideIds?, startSlideId? })` — overview or selected details, revision guard value and budgeted continuation
- `slides_render({ presentationId? | presentationUrl?, slideIds? })` — selected slide PNGs saved into this conversation, in presentation order; with more than one slide also one 2-column contact-sheet PNG (`contactSheet: { path, columns, slideIds } | null`, `contactSheetError` if it could not be built) — read that first, open single slides only for detail
- `validate` — confirm the connection is live; returns the connected Google account

Read-only scopes: `drive.readonly` + `userinfo.email` (unchanged). With `allowWrite: true`, also requests `drive.file`, `spreadsheets` and `presentations`; no full `drive` scope. `drive.file` permits creating/editing app-created files; `spreadsheets` permits editing existing Sheets; `presentations` permits editing existing decks when the user has edit permission. Existing write-enabled connections reconnect once for the new scope. Read tools retain `drive.readonly`.

Write tools (only mounted when `allowWrite: true`):

- `slides_create({ title, parentId?, slides? })` — native deck; each slide takes `elements` (point-based text/rect/roundRect/ellipse/line/image), `background`, `notes` and legacy `images`; returns `slides: [{ slideId, elementIds }]`
- `slides_add_elements({ presentationId? | presentationUrl?, slideId? | newSlide?, elements, requiredRevisionId?, render? })` — add point-based elements to a slide or a new blank slide in one batch update
- `slides_batch_update({ presentationId? | presentationUrl?, requests? | requestsPath?, requiredRevisionId?, renderSlideIds? })` — pass-through Google Slides requests (or a conversation-root JSON file: array or `{ requests }`, max 5 MB); revision-guarded edits in place; a string `replaceAllText.containsText` is normalized to `{ text, matchCase: true }`
- `create_folder` — name and optional parent folder id
- `save_file({ path, fileId? | name + parentId?, convert? })` — upload a local conversation file as a new copy or replace an app-accessible file while keeping its format
- `create_file` — text/CSV content, optional MIME type/parent; `convertTo: "doc" | "sheet"` creates a Google Doc or Sheet
- `update_file_content` — overwrite content (text for Docs, CSV for Sheets)
- `rename_move_file` — rename and/or add/remove parent folders
- `sheets_update_range` — A1 range and `values` row arrays; `valueInputOption` `USER_ENTERED` (default) or `RAW`

All Sheets tools accept `spreadsheetId` or `spreadsheetUrl`. Sheets reads work under `drive.readonly`; Google Sheets API must be enabled.
- `sheets_append_rows` — A1 table range and `rows` arrays; `valueInputOption` `USER_ENTERED` (default) or `RAW`

Read the target before writing, confirm when ambiguous, and report what changed. Deleting, sharing, and permissions are not exposed. Explicit OAuth scope refusals return `insufficient_scope`; download restrictions, export-size errors and file-permission refusals retain actionable Google errors. Rate limits retry twice, then return `rate_limited`.

## Work with real files

Use `read_file` for extracted text. For native Slides, use the deck workflow below. For Docs, Sheets and binary files, when layout, headers, footers, logos, images or styles matter, use `download_file` → edit its returned local `path` → `save_file`. Send the edited local file to the user with `send_file` where useful.

`download_file` returns `{ fileId, name, mimeType, path, bytes }`. The host supplies a trusted `conversationFiles: { hostPath, runtimePath }` execution context, never an agent-derived shared folder. The returned path works inside the active runtime; local runtimes use the host path and containers use `/workspace/files`. Files remain private to the current conversation. Binary downloads retain exact bytes and stop at 25 MiB counted on the stream, even without Content-Length. Native exports use Google's 10 MB limit. Owner download restrictions, unsupported native types (including folders and shortcuts), cancellation and timeout leave no partial file. Shared-drive metadata and media requests use `supportsAllDrives=true`.

`save_file` accepts an absolute runtime path (or a host path inside the same conversation folder), rejects path escapes and symlinks pointing outside, and returns `{ fileId, name, mimeType, webViewLink }`. Save regular files directly in the conversation folder root; nested paths are rejected to prevent mutable ancestor symlinks from escaping the folder. Without `fileId`, supply `name` and optionally `parentId` to create a binary file in its local format. With `fileId`, omit `name` and `parentId`: binary formats stay binary and native Docs/Sheets/Slides import the matching docx/xlsx/pptx back into the original native file. A mismatched replacement format is rejected. For a new copy only, `convert: true` imports DOCX, XLSX or PPTX as native Docs, Sheets or Slides. Conversion with `fileId`, or conversion of other formats, is rejected. Chat uploads are read-only: copy them into the conversation folder root first.

Google documents that [Office upload conversion during an update replaces the complete contents of an existing Google Doc, Sheet or Slide](https://developers.google.com/workspace/drive/api/guides/manage-uploads#convert_to_google_docs_types). Multipart uploads use Office media Content-Type and the target's existing native MIME type in metadata. Actual Google conversion and fidelity must also be verified against a connected test account.

The approved scope remains `drive.file`, not full `drive`. Creating copies works; replacing arbitrary user-owned files does not. Replace only files the app created or the user explicitly authorized for this app. A Google Sheets grant alone does not authorize a Drive media replacement of an arbitrary existing Sheet. For Frederic's template, download the original docx, edit only its body, and save a new docx copy.

## Native Google Slides

Availability uses the existing per-agent Google Drive opt-in, `allowWrite` for writes, user consent and an enabled Google Slides API. No separate Slides extension or agent runtime software is required. `slides_get` and `slides_render` remain available in read-only mode.

1. Read the agent skill's brand rules, get the page size and convert its design units to slide units (thumbnail pixels are not slide units).
2. Create or edit with Slides tools. Before editing an existing deck not created in this conversation, call `slides_get` and pass its `revisionId` as `requiredRevisionId`; after a stale revision, read again before retrying.
3. Render changed slides, look at every render and fix overlaps, cut text, wrong fonts and wrong colors. Use exact Google Fonts family names: Google silently substitutes Arial for unknown names.
4. Deliver the Drive link and explain what changed.

References accept exactly one of `presentationId` and `presentationUrl`, including Slides and Drive file links. An omitted/empty `slideIds` returns an overview in `slides_get`, or renders all slides in `slides_render`. Non-empty selections return presentation order with one-based slide numbers. Get responses have hard JSON budgets (40,000 overview / 60,000 details characters); use `nextSlideId` as `startSlideId` to continue. Oversized details return 413 with guidance to use the overview and render.

Prefer public PNG, JPEG or GIF URLs for `createImage`; private Drive links, local paths and SVG files do not work. For a private logo, skill asset or chat upload, first copy the image into the conversation folder root, then pass `slides: [{ images: [{ path, x, y, width, height }] }]` to `slides_create`. Each slide uses a 720 x 405 pt (16:9) page; image boxes preserve aspect ratio and center without cropping. Blank image lists create blank slides. Local images are supported at creation only; existing decks use public image URLs.

Element format (`slides_create` slides and `slides_add_elements`), all geometry in points on the 720 x 405 page: `{ kind: text|rect|roundRect|ellipse|line|image, id?, x, y, w, h, text?, font?, size?, bold?, italic?, color?, align?, valign?, lineSpacing? (percent), fill?, outline?: { color, weight? }, radius?, url?, path? }`. Colors are `#RRGGBB`; `\n` separates paragraphs; no `outline` means no outline. `id` is only used by `slides_add_elements`. `roundRect.radius` (points) works only in `slides_create` — the Slides API cannot set corner radius, but the imported PPTX keeps it. Images: `path` (conversation-root file) in `slides_create`, public https `url` in `slides_add_elements`. `slides_create` returns `slides[].elementIds` in drawing order: legacy `images` first, then `elements`. Rename the new file with `rename_move_file`.

Recommended loop: one `slides_create` with all slides' elements → `slides_render` once and read `contactSheet.path` → fix with `slides_add_elements`/`slides_batch_update` → re-render only changed slides.

Local-image limits (element images count too): 50 slides, 30 images, 10 MB/image and 50 MB generated PPTX. The extension builds and imports the PPTX itself, using multipart upload up to 5 MB and resumable upload above that. A creation inspection failure returns the created id/link and error: inspect that deck with `slides_get`, without creating another copy.

Renders use at most three parallel requests, with 30 seconds per thumbnail/download and 120 seconds overall. Each image is limited to 10 MB. Failure/cancellation removes only files created by that call; signed URLs and bearer tokens never appear in the output. Render only changed slides: thumbnails cost expensive-read quota (60/user/minute, 300/project/minute). Short retries cannot replenish quota; after `rate_limited`, wait.

PPTX extraction follows presentation relationships for slide order, including shapes, groups, tables and notes. Limits are 25 MiB input, 2,000 ZIP entries, 20 MB inflated per entry and 100 MB total, checked during extraction.

Release together with the Drive download/save round-trip and platform PPTX upload support (`73268aee`). Platform web MIME validation retains its documented permissive behavior; gateway validation rejects a wrong MIME with a `.pptx` filename.

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

1. **Enable the Google Drive API, Google Sheets API and Google Slides API** (APIs & Services → Library).
2. **OAuth consent screen** — add `.../auth/drive.readonly` and `userinfo.email`; write mode also needs `.../auth/drive.file`, `.../auth/spreadsheets` and `.../auth/presentations`.
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

## Human Slides verification before release

Thinh owns these live checks using the external-testing OAuth app; agents do not run OAuth end to end.

1. Give a brief and create a 10-slide deck in a named folder, using the brand skill and its real public or local logo.
2. Verify 16:9 geometry, design-unit conversion, exact Google Fonts and weights, logo variants and colors.
3. View all ten renders and fix findings before delivery.
4. Upload a PPTX in chat, convert it to a native deck and restyle it.
5. Mandatory hybrid check: import local PNG, JPEG and GIF images; verify positions, aspect ratios, PNG transparency, slide order and 16:9 page size after Google conversion.
