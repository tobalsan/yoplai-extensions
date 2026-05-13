# Jira Extension PRD

## Goal
Add a `jira` extension similar to Confluence extension patterns, with scoped Jira Cloud read/write tooling.

## Configuration
- `subdomain` (required)
- `email` (required)
- `apiToken` (required)
- `jiraProjectKeys?: string[]` (optional allowlist; may be supplied directly as an array or via `$env:` as JSON array / comma-separated string)
- `readOnly?: boolean` (default `false`)
- `timeoutMs?: number` (default `30000`)

Docs examples should use `JIRA_SUBDOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.

## Scope and Access
- If `jiraProjectKeys` omitted: allow all token-accessible projects.
- If present: enforce project allowlist.
- Reads are filtered by allowlist.
- Writes are restricted to allowlist.
- For issue-key writes, validate with key prefix + fetch issue project verification.

## Tools
### Read tools
- `search` (JQL or structured filters; pagination `startAt`/`maxResults`)
- `get_issue` (curated default fields)
- `get_create_metadata`
- `get_transitions`
- `list_projects`
- `list_issue_types`
- `list_fields`
- `list_boards`
- `get_board_configuration`
- `search_users`
- `list_comments`
- `validate`

### Write tools (hidden when `readOnly=true`)
- `create_issue`
- `update_issue`
- `add_comment`
- `transition_issue`

## Write Behavior
- `dryRun` supported on write tools.
- `dryRun` performs remote validation where feasible, but does not mutate.
- `create_issue` supports flexible `fields` payload + common named fields.
- `update_issue` supports hybrid named fields + raw `fields`.
- `transition_issue` accepts `transitionId` or `transitionName`.

## Content Format
- Comments/descriptions accept plain text by default.
- Optional raw ADF supported.

## Errors
- Return concise normalized message + raw Jira payload and request id when available.

## Testing
- Unit tests (mocked) in regular `test` run.
- Optional integration check script/test using `JIRA_*` env vars for:
  - auth (`/myself`)
  - projects
  - boards
  - sample scoped search
