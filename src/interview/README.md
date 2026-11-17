# Interview

Agents ask a batch of questions with `interview_ask`, then call `interview_wait`
to receive answers or park the turn. Web chat opens the form in the side panel.
On other surfaces the agent must post the returned link and end its turn so the
human can see it; submit resumes the same session.

Enable `interview: {}` in the gateway's `extensions` and the agent's `extensions`.
No additional configuration is required. Links use `server.baseUrl`, then
`web.baseUrl`, then `http://localhost:<ui.port>`.

The gateway must support extension page routes and host-owned agent access
checks; otherwise the tool returns a clear upgrade error. Without the panel
hook, the link still works. Without run origin, there is no surface recap or
wake reply delivery. Merge the platform hooks before installing the extension.

## Form

`interview_ask` requires a `title`, situation `summary`, and `questions`. Each
question has a unique `id`, a `type` (`single`, `multi`, `text`, or markdown
`info`), and `question`. Object prototype property names are reserved IDs.
Choice questions accept `options` with `label` and optional `description`,
`recommended` label(s), and recommendation `context`. Choice answers always
offer Other; every answer permits a note.

The form supports Save draft, a locking Submit, read-only submitted answers,
and inline Ask, Generate more, and Review options. Each assist uses a fresh
one-shot session of the same agent, includes the situation and full questions,
excludes the draft, and deletes its runtime session afterward. When supported by
the host, persisted assist history is also removed so it stays out of chat lists.
One assist runs per form and times out after 90 seconds. Delivery waits at most
15 seconds so a stalled recap cannot prevent the main agent from waking.

`interview_wait` defaults to 240 seconds, caps waits at 270 seconds, and emits a
60-second heartbeat. A live submit resolves the waiter without another turn.
A late submit wakes the stored session. Queued wakes complete when the gateway
accepts them; any deferred reply is delivered through the origin sink.
Recaps are capped at 1,500 characters. Telegram and Discord recaps are chat-level.

Limits: 30 questions, 12 options per question, 256 KB per form definition and
256 KB per answer set. Pending forms and drafts survive restarts. Submitted
forms with an incomplete wake are retried once on startup. Atomic submission
prevents a double click or second tab from waking twice.

## Access

In multi-user mode only the gateway user who started the run can open or answer
the form. Unlinked senders must link their account first; there is no fallback
owner. Threadit and Mattermost linking uses the platform's account connections.
Telegram and Discord have no pairing in this version.

In single-user mode the owner is `local`, no user ID is required, and anyone who
can reach the gateway can answer, including forms started from other surfaces.
Each page load receives a form/viewer-bound HMAC token. Cookie-free sandbox calls
recheck current agent access. Tokens expire after eight hours; reload a pending
form to renew. Impersonated pages receive no token and remain read-only.

## Keyboard

Arrows or `j`/`k` move between questions; `1`–`9` pick choices; `o` opens Other;
`n` opens a note; Cmd/Ctrl+S saves; Cmd/Ctrl+Enter submits; `?` toggles help.

`ask-human` is unchanged.
