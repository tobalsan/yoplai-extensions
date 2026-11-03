# ALG-605 validation (2026-11-03)

- Extensions branch: `ALG-605-gmail-attachments-send`, PR #22, base `main`.
- Platform revision: `3b6beb23` (isolated clone; no platform source changes).
- Isolated home: `platform-preview/.yoplai-e2e` inside the issue workspace.
- Real dev gateway: `http://127.0.0.1:4080`; UI: `http://127.0.0.1:3080`.
- Startup used placeholder Google OAuth client credentials for checkbox validation only.
- Production port 4000 and production configuration were untouched.

## Commands

```sh
env -u YOPLAI_HOME pnpm test
pnpm build
git diff --check
YOPLAI_HOME=<issue-workspace>/platform-preview/.yoplai-e2e pnpm dev
playwright-cli -s=alg605-checkbox open http://127.0.0.1:3080/agents/gmail-check/extensions/gmail
playwright-cli -s=alg605-checkbox snapshot
playwright-cli -s=alg605-checkbox click <checkbox-ref>
NODE_OPTIONS=--conditions=development pnpm exec tsx validation/live-tool.mts tools
```

## Results

- PASS: 1,485 tests across 92 files; build and whitespace checks pass.
- PASS: default-off/merged configuration gating, metadata/download filesystem safety, MIME uploads, reply metadata, missing-success-ID and refusal behavior.
- PASS: 25,000,000 original attachment bytes accepted; one byte more refused before upload. 36,700,160 MIME bytes accepted; one byte more refused.
- PASS: inline and remotely stored draft attachments retained when omitted; explicit empty/list removes/replaces.
- PASS: cancellation of account preflight, attachment response, send response, and draft readback releases the caller and permits subsequent work.
- PASS: real UI checkbox rendered, toggled off then on, and persisted. Screenshots and DOM: `03-gmail-checkbox-off.*`, `04-gmail-checkbox-on.*`.
- PASS: real host extension runtime omitted both send tools when off and included them when on; download remained present (`03-tools-off.json`, `04-tools-on.json`).
- UI emitted 404s for optional multi-user `/api/auth/get-session` and `/api/impersonation/status` in the single-user preview; checkbox save and persistence succeeded.
- Clean in-process reviewer pass after fixing inline attachment preservation and preflight/readback cancellation.

## Live mailbox acceptance pending

- Browser launch attempted with declared password and authenticator secret refs for the dedicated Google test account.
- `e2e-browser` refused startup: authenticator reference could not be read from 1Password; no browser created.
- `op whoami` reports not signed in; metadata/list commands hung and were stopped.
- Access request: https://discord.com/channels/1456395729663819808/1567097222594560050
- Local callback request (production occupies 4000): https://discord.com/channels/1456395729663819808/1567098183887102094
- NOT RUN: live PDF download/read -> draft visible in Gmail.
- NOT RUN: delivered `send_email` with attachment and approved CC; existing `send_draft` delivery.
- NOT RUN: ~20 MB attachment draft accepted and visible in Gmail.
- No mailbox mutations or email sends this run.

## Source verification

- Google upload guide: https://developers.google.com/workspace/gmail/api/guides/uploads
- Send scope: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Draft-send scope: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send
- Draft upload resource: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create
- Draft update upload resource: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/update
- Gmail discovery: https://gmail.googleapis.com/$discovery/rest?version=v1 (`mediaUpload.maxSize=36700160`, `accept=message/*`).
- `gmail.modify` covers both send operations; unchanged scope list means no reconnect required.
