# Gmail extension

Gmail mailbox tools for an agent, via **Google OAuth** — personal (**Just me**) or shared (**Whole team**) connections — no pasted secrets. The host supplies a fresh Google OAuth token when building the agent's tools; this extension stores neither tokens nor mailbox data.

Tools (mounted as `gmail_<name>`): 13 always available, plus two sending tools when enabled:

- `create_draft` — create an email draft without sending it (supports `to`/`cc`/`bcc`, text or HTML body, `replyToMessageId`, and `attachments: [{ path }]`)
- `update_draft` — update an existing draft by Draft ID; omitted fields keep current values, including attachments (`[]` removes them, a list replaces them; HTML body dropped unless resent)
- `delete_draft` — permanently delete a draft by Draft ID
- `list_drafts` — list drafts, paginated, optional Gmail query
- `get_thread` — get a thread and its messages (`MINIMAL` or `FULL_CONTENT`); full messages include attachment `messageId`, `attachmentId`, `partId`, `filename`, `mimeType`, and `size`
- `download_attachment` — save original attachment bytes to the conversation folder; pass `messageId`, `attachmentId`, and `partId` from `get_thread` (or `filename` and `size` if `partId` is unavailable); returns `path`, `name`, `mimeType`, and `bytes`
- `search_threads` — search threads with Gmail query syntax, paginated, optional `includeTrash`
- `label_thread` / `unlabel_thread` — add/remove labels on a thread
- `label_message` / `unlabel_message` — add/remove labels on a message
- `list_labels` — list user-defined labels, paginated
- `create_label` — create a label, optional colors
- `send_email` — send with recipients, text/HTML body, optional reply threading and attachments (`allowSend: true` only)
- `send_draft` — send a Draft ID from `list_drafts` without `query` (`allowSend: true` only)

Scopes requested: `gmail.modify` + `userinfo.email`. Google's [messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send) and [drafts.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send) references list `gmail.modify`, so existing connections need no reconnect. Sending is controlled by tool availability, off by default. No settings tools are exposed.

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

Opt in under `extensions` in the agent's `agent.yaml`; the host injects the token. Sending is off by default; enable it only for agents that should send mail.

`~/.yoplai/agents/<agent>/agent.yaml`:

```yaml
extensions:
  gmail: {}                # downloads and drafts; sending disabled
```

A fuller example alongside other extensions:

```yaml
name: mail-triage
model: claude-sonnet-5
extensions:
  gmail: { allowSend: true }
  googleDrive: {}
```

The Gmail extension page displays **Enable sending email**, an unchecked checkbox by default. For a **Just me** connection, the user controls this personal setting, shared across their agents. For a **Whole team** connection, an admin controls the setting per agent, matching Google Drive's `allowWrite` behavior.

When send tools are available, confirm recipients and the attachment with the user before each send, unless a scheduled job states its own send rule. A successful send returns `messageId`, `threadId`, and `account`; failures are reported without automatic retries.

## Attachment limits

Gmail can change `attachmentId` between message reads. Keep the caller's `attachmentId` for downloading, and pass the stable `partId` to locate its filename and MIME type. Without `partId`, `filename` and `size` must uniquely identify the attachment; ambiguous matches fail and require `partId`. Legacy calls with just `messageId` and `attachmentId` still work when the ID matches the current message response; use the selectors above to handle changing IDs.

- Downloads: 25 MiB per file, 30-second timeout, caller cancellation supported. Oversized or interrupted downloads leave no partial file.
- Draft/send attachments must resolve to regular files inside the current conversation folder. Paths escaping it and symlinks escaping it are rejected; nested paths are unsupported on non-Linux hosts.
- At most 10 attachments per outgoing message. Total original attachment bytes must not exceed **25 MB (25,000,000 bytes)**. The complete MIME message (headers, bodies, and base64 attachments) must not exceed **36,700,160 bytes** (`MAX_MIME_BYTES`). Both limits are checked before uploading.
- Draft creation, draft updates, and email sending use Gmail's media upload endpoints: `uploadType=media` for MIME alone, or `uploadType=multipart` with JSON metadata and `message/rfc822` for replies/thread preservation. The MIME is uploaded directly rather than base64url-encoded again in JSON.
- Downloaded files can be read, displayed, or reused with `attachments: [{ path: "<returned path>" }]`. Draft results list attachment filenames, MIME types, and sizes so a human can inspect the draft in Gmail before sending.

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
- Each connection is either **Just me** (personal: used only for that user's requests) or **Whole team** (shared fallback for everyone on the agent). Tool calls use the requester's personal connection first, then the team connection; another user's personal connection is never used. Only admins can change the Whole team connection.

## 5. User: connect

In the Yoplai web UI, open the agent's **Gmail** extension page (or the agent's **My connections** tab), pick the **Just me** or **Whole team** tab, and click **Connect**. This opens Google's consent screen; on return the state shows **Connected as `<email>`**.

- **Needs reconnect** (grant revoked/expired-beyond-refresh) → click **Reconnect**.
- **Disconnect** revokes and clears the grant.

---

## Behavior notes

- `list_drafts` normally returns Gmail Draft resource IDs. Gmail's REST drafts endpoint cannot filter by query; when `query` is provided, the extension searches `in:draft` messages with Gmail query syntax instead. In that response, `draftIdKind` is `"message"` and each `id` is a Gmail message ID.
- `list_labels` returns user-defined labels only, as the Gmail MCP contract does. Gmail system label IDs such as `INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, and `IMPORTANT` remain valid inputs for label mutation tools.

Operator reference (host repo): `yoplai/docs/oauth-google-drive-setup.md` (same Google OAuth framework).
