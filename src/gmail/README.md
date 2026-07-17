# Gmail extension

Opt an agent in with `extensions.gmail: {}`. The host supplies a fresh Google OAuth token; this extension stores neither tokens nor mailbox data.

The extension exposes Google Gmail MCP's current ten-tool surface. Every successful result includes `account`, the connected mailbox identity.

`list_drafts` normally returns Gmail Draft resource IDs. Gmail's REST drafts endpoint cannot filter by query; when `query` is provided, the extension searches `in:draft` messages with Gmail query syntax instead. In that response, `draftIdKind` is `"message"` and each `id` is a Gmail message ID.

`list_labels` returns user-defined labels only, as the Gmail MCP contract does. Gmail system label IDs such as `INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, and `IMPORTANT` remain valid inputs for label mutation tools.
