# Pipedrive extension

Pipedrive CRM access for an agent. **Read-only by default.** With `allowWrite: true` the agent can also create and update leads, deals, persons, organizations, notes, activities and lead labels, and convert leads to deals — every change guarded by confirmation, search-before-create, stale-edit protection, visible agent markers and trace notes.

Tools are mounted as `pipedrive_<name>`. Authentication is one shared Pipedrive API token (`apiToken`, e.g. `$env:PIPEDRIVE_API_TOKEN`) for the company `domain`.

## Enabling writes

`allowWrite` defaults to `false`; existing agents stay read-only until a root or agent setting turns it on. The agent setting overrides the root default, including an explicit `false`; omitting it inherits the root value (so a root `true` enables writes for every agent that does not set `false`).

`yoplai.json` (shared defaults):

```json
{
  "extensions": {
    "pipedrive": { "domain": "$env:PIPEDRIVE_DOMAIN", "apiToken": "$env:PIPEDRIVE_API_TOKEN", "allowWrite": false }
  }
}
```

`~/.yoplai/agents/<agent>/agent.yaml`:

```yaml
extensions:
  pipedrive:
    apiToken: "$env:PIPEDRIVE_API_TOKEN"
    domain: "$env:PIPEDRIVE_DOMAIN"
    allowWrite: true   # false disables writes for this agent (beats a root true); omitting it inherits the root setting
```

The write tools and the supporting reads (`search_persons`, `search_organizations`, `list_contact_fields`, `get_activity`, `list_activity_types`) are only mounted when the merged `allowWrite` is `true`. The 27 original read tools are always present. The direct client (`PipedriveWriteClient`) also refuses every mutation with zero requests when the gate is off.

## Who is the requester?

All agents share one token, so Pipedrive sees a single user. Attribution is **conversational**: every mutation tool requires `requested_by` (the human's name, taken from the conversation; the agent asks if unknown). It is written into the visible agent marker / trace note. It is **not authenticated identity proof**, and it must never be the shared token owner, the CRM record owner or the agent name. (The local `defineToolExtension` helper passes tools only `{ agentId }`, so host requester ids are not available to extensions yet.)

## Write tools

| Tool | Endpoint | Confirmation |
|---|---|---|
| `create_lead` | `POST /api/v1/leads` | Hard |
| `update_lead` (incl. `is_archived`) | `PATCH /api/v1/leads/{id}` | Hard |
| `create_deal` | `POST /api/v2/deals` | Hard |
| `update_deal` (stage, `status` open/won/lost, `lost_reason`) | `PATCH /api/v2/deals/{id}` | Hard |
| `create_person` | `POST /api/v2/persons` | Hard |
| `update_person` | `PATCH /api/v2/persons/{id}` | Hard |
| `create_organization` | `POST /api/v2/organizations` | Hard |
| `update_organization` | `PATCH /api/v2/organizations/{id}` | Hard |
| `create_note` | `POST /api/v1/notes` | Soft |
| `create_activity` (person linked as primary participant) | `POST /api/v2/activities` | Soft; explicit owner = hard |
| `update_activity` (complete with `done`) | `PATCH /api/v2/activities/{id}` | Soft; owner change = hard |
| `convert_lead_to_deal` | `POST /api/v2/leads/{id}/convert/deal`, poll `GET /api/v2/leads/{id}/convert/status/{conversion_id}` | Hard |
| `create_lead_label` | `POST /api/v1/leadLabels` | Hard |
| `update_lead_label` | `PATCH /api/v1/leadLabels/{id}` | Hard |

Supporting reads: `search_persons` (`GET /api/v2/persons/search`), `search_organizations` (`GET /api/v2/organizations/search`), `list_contact_fields` (`GET /api/v1/personFields` / `organizationFields`), `get_activity` (`GET /api/v2/activities/{id}`), `list_activity_types` (`GET /api/v1/activityTypes`). `get_person` / `get_organization` accept optional `output_type: "full"` (owner, timestamps, normalized custom fields + metadata); omitting it returns the original projection.

Not provided on purpose: deletes, merges, followers, schema admin (fields/pipelines/stages), products, discounts, invoicing write-backs, uploads, a generic API tool or bulk mutation tool. Archive with `update_lead` (`is_archived`); flag suspected duplicates with a note naming the duplicate ids (optionally an existing "Possible duplicate" label via `update_lead`), never merge.

### Hard vs soft confirmation

*Hard* tools require `confirmed: true` (a schema literal, no default). The prompt tells the agent to set it only after the human saw the exact before→after and approved. `confirmed: true` is an enforceable argument requirement, **not verified human approval** — the prompt and tool descriptions carry the real consent flow. A batch approval covers only the listed records and changes (typically ≤ ~20, one call each); the agent stops the batch on a conflict, unknown outcome or audit failure.

*Soft* tools (notes, routine activity logging and completion) need no approval when directly requested, but are still marked agent-made. Activity owner assignment/reassignment needs `confirmed: true`.

## Safety behaviour

- **Read before write, stale-edit protection.** Updates take typed `changes` plus `expected_before` holding the current value of **every** changed field (and every changed custom field). The tool re-reads the record; any mismatch returns `status: "conflict"` with the actual values and sends nothing. Only changed fields are sent; true no-ops return `unchanged` with no PATCH and no trace. This is not an atomic compare-and-swap: another writer can still race between the final GET and the PATCH (the Pipedrive API offers no conditional write).
- **Search before create, enforced in code, no `force`.** Persons: every email, phone and the name. Organizations: name, plus VAT/SIREN-named custom field values. Leads: exact title search (`GET /api/v2/leads/search`, cursor-paginated) plus listing of the linked person/org's leads **including archived**. Deals: exact title search. Exact existing notes/activities/labels are `reused` (id returned). A candidate result is `status: "duplicate_candidates"` and nothing is created. A failed, malformed (envelope, row without an id, unusable pagination), looping or truncated (20-page cap) search — and a malformed lead-label list or field-definition page — **blocks the write** instead of meaning "no match". Application checks reduce duplicates but are not server-side uniqueness: concurrent clients can still race. Pipedrive's search index only covers a person's **primary** email/phone when the person is created (a secondary entry becomes searchable only after a later `PATCH`), so a duplicate that matches only a non-primary email or phone is not detected.
- **Field replacement semantics.** `label_ids`, `emails`, `phones` and set custom fields are full replacement lists; omitted fields are unchanged; `null` clears only where the schema allows (lead `expected_close_date`, lead `person_id`/`organization_id`, person `org_id`, custom fields). A **deal** `expected_close_date` cannot be cleared through the API: v2 rejects `null` (400 `expected_close_date: The value is not a valid 'string'`) and turns `""` into `0000-00-00`, so `update_deal` refuses `null` before sending anything. A multi-option (`set`) custom field is cleared with `[]` or `null` in the tool input; the API payload is always `null` (Pipedrive rejects `[]`). An organization `address` is a full replacement compared by its formatted line **and** every component (omitted components are cleared); `expected_before` accepts the shape `get_organization` returns (`formatted_address`, null parts). Likewise `expected_before` accepts `get_person` contact entries (`label: null`) and `HH:MM` activity times. Activity `due_time` / `duration` are written as `HH:MM` (the live API rejects `HH:MM:SS`). A lead must keep at least one contact link. Owners are checked against active users (`list_users`); a stage must belong to the given pipeline.
- **No ambiguous mutation replays.** Only an explicit 429 is retried (bounded, honoring `Retry-After`). Timeouts, network failures, 5xx and malformed success bodies raise an *outcome unknown* error telling the caller to read the record before any retry. Reads keep their existing retry behaviour.

## Agent markers and trace notes

All note/activity text is treated as plain text and HTML-escaped.

- Notes: `[Agent-made for <requested_by>]` paragraph, rendered by the tool. Pipedrive re-serialises note HTML on save (`&amp;` → `&`, `&quot;`/`&#39;` → quotes, whitespace collapsed), so exact-note reuse compares in that stored form.
- Activities: subject prefixed `[Agent] `; note starts with the same marker exactly once, existing human note content is kept, and each update appends a visible `Agent update for …` line (a completion-only update still adds attribution; a note edit is recorded as `Note edited`).
- After every successful lead/deal/person/organization update the tool writes **one** note on the record: `Updated by agent for Éric (2026-…Z): Owner Alice → Bob; Forecast category Pipeline → Commit.` Before-values come from the preflight read. Creations get `Created by agent for …`. Conversion writes `Lead <id> → Deal <id> … (conversion <id>)` on the destination deal, deduplicated by conversion id; if the duplicate lookup itself fails, no trace is posted and the result is `converted` with `partial_success: true`, `trace_repair: null` and an instruction to resume with the same `conversion_id` (never `create_note`: a fresh timestamp would not match an existing trace). If status polling fails after the conversion was accepted, the result is `pending` with the `conversion_id` (resume with it; it never re-sends the conversion). Label-definition changes are traced on the required `audit_lead_id` (labels cannot own notes) and warn that renames affect every lead using the label.
- The change and its trace are two API calls, not a transaction. If the change succeeds but the trace fails, the result is `applied: true, partial_success: true, trace_status: "failed" | "unknown"` with `trace_repair` (target + exact content). Repair with the deduplicating `create_note`; never repeat the change. The tool never claims a fully audited success while the trace is missing.

## Custom fields

`custom_fields` maps an exact 40-char hash key or an unambiguous, case-insensitive field name to a value. The tool fetches **complete, fresh** field definitions on every custom-field write (no cache or stale-grace fallback; it fails closed if pagination fails, loops or exceeds 20 pages). Duplicate names are rejected with the candidate keys; unknown fields and standard/read-only fields are rejected (writability is not inferred from `edit_flag`).

| Field type | Input | v2 body (`custom_fields[key]`) | v1 lead body (top-level key) |
|---|---|---|---|
| text / varchar / phone / int / double / date / time / user / org / people | validated scalar or `null` | value | value |
| enum | option label or id | option id | option id |
| set | array of labels/ids | id array | **rejected** |
| monetary | `{amount, currency}` | `{value, currency}` | **rejected** |
| daterange / timerange | `{from, until}` | `{value, until}` | **rejected** |

Set, monetary and range encodings for **v1 lead payloads are not verified** against the live API, so leads fail closed on them (change those on the deal after conversion). Other field types (address, visible_to, …) are unsupported. **VAT / SIREN** are organization custom fields: look them up with `list_contact_fields` and write them through `custom_fields` (the standard-field substring heuristic used by `get_organization` is read-only).

## Lead sources

`GET /api/v1/leadSources` (`list_lead_sources`) is discovery-only. No source-definition writes are exposed and `source_name` is not writable; `channel` / `channel_id` are not exposed on `create_lead` / `update_lead` either, because writability was not confirmed. Source/channel assignment is a known limitation.

## API contract status

Endpoints and payloads were checked against the official Pipedrive API reference and the v2 migration guide (Leads, LeadLabels, Notes, Activities, Persons, Organizations, Deals; v1 CRUD for activities/deals/persons/organizations is out of support since 2026-08-01, so those use v2). Corrections from that check: activity creation links a person through `participants: [{ person_id, primary: true }]` (v2 `person_id` is read-only), an empty multi-option field is sent as `null`, and the lead duplicate search uses `GET /api/v2/leads/search` with cursor pagination. Fixtures in `src/pipedrive/__tests__/` follow the documented response shapes; they are mocks, not live verification, and no production mutations are performed by tests.

Verified against a disposable Pipedrive sandbox on 2026-10-16 (details in the sandbox checklist below). Items that were open before that run:

1. Lead conversion: **verified.** The response carries `data.conversion_id`; `GET …/convert/status/{id}` returns `{conversion_id, status: "completed", deal_id}`; an unknown or expired id answers `404 {"code":"JOB_NOT_FOUND"}` (handled as a resumable `pending`). Not observed: a `failed`/`rejected` conversion.
2. v2 activity `due_time` / `duration`: **fixed.** The API accepts only `HH:MM` (`09:30:00` → 400 `due_time: This value is not a valid datetime.`); reads return `HH:MM`.
3. Nested `person` / `organization` objects in v2 `deals/search` items: **verified** (`{id, name}` / `{id, name, address}`).
4. `PATCH /persons/{id}` replaces the whole `emails` / `phones` array: **verified** (an omitted entry is dropped; the other array is untouched).
5. Organization `address`: **verified.** PATCH nulls every omitted component; v2 returns the display line as `value` (`formatted_address` is `null`).
6. v2 pagination metadata: **verified.** Every v2 list/search ends with `additional_data.next_cursor: null`, including an exactly-full final page; v1 lists end with `pagination.more_items_in_collection: false`.
7. v1 lead custom-field encoding for set, monetary and range fields: **still unverified** (fail closed). Lead null clearing (`expected_close_date`, `person_id`, custom fields) and `is_archived` (without an archive reason) **verified** on a sandbox company that does not require an archive reason.
8. `users`, `dealFields` / `personFields` / `organizationFields`, `leadSources`, `activityTypes`, `stages/{id}`, `pipelines` envelopes: **verified.**
9. Duplicate search by organization custom field: **verified** for `varchar` (VAT) and `double` (SIREN); other searchable types not exercised.
10. Lead-label colors `green`, `blue`, `red`, `yellow`, `purple`, `gray` are all accepted by the API (`brown`, `dark-gray`, `orange`, `pink` not exercised).
11. The read tool `search_leads` (`GET v1 /leads/search`) still works.
12. New live findings: a deal `expected_close_date` cannot be cleared (see above); Pipedrive search ignores non-primary person emails/phones at creation; note HTML is re-serialised on save.

Mocked request/response fixtures live in `src/pipedrive/__tests__/` (`writes.test.ts`, `write-support-reads.test.ts`).

## Sandbox acceptance checklist

Run on 2026-10-16 against a disposable sandbox company (`ZZ-agent-test…` records, no deletes/merges). Harness and raw results live outside the repo.

1. **Gate — verified.** `allowWrite` omitted/`false` mounts exactly the 27 original read tools; `true` mounts 46 (19 extra); `PipedriveWriteClient` with the gate off refuses with zero requests. (Root-vs-agent config merge is done by the host and was not exercised.)
2. **Lead — verified.** Edit title/value/close date, enum + text custom fields (null clears), owner (unchanged no-op), labels (full replacement), person relink / `person_id: null`, both links removed → rejected locally, archive + unarchive (no archive reason required in this sandbox), conflict after an external edit, trace notes. Unknown label id → API 400, nothing written.
3. **Contacts — verified.** Org/person duplicate checks by name, VAT string, numeric SIREN, primary email, primary phone; address replace/clear/round-trip; email/phone full replacement; `org_id` null/relink. **Limitation:** a *secondary* email/phone of a freshly created person is not in Pipedrive's search index, so it is not detected as a duplicate.
4. **Notes/activities — verified.** Notes on deal/person/lead/org; identical note `reused` (after fixing `&` normalisation); activity with a person only → primary participant; `HH:MM` times; identical activity `reused`; complete with `done`; owner needs `confirmed`; note edit keeps one marker.
5. **Deal — verified.** Stage move, pipeline/stage mismatch rejected, won / lost / lost + reason / reopen, enum/set/monetary/daterange writes and null clears, `[]` on a set field sent as `null`, same-title detection of open, lost and won deals. Clearing a deal `expected_close_date` is not possible (refused). **Conversion — verified:** one convert POST, `conversion_id`, status `completed`, trace on the deal, resume with the same id (no new POST, no duplicate trace), bogus id → `pending` (`JOB_NOT_FOUND`). Not observed: a `failed` conversion or a visible `running` state.
6. **Lead labels — verified.** Create, same-name `reused`, rename, all six colors, stale conflict, audit-lead trace with the global-impact warning; a nonexistent audit lead is rejected before any change.
7. **Trace failure — not run.** Revoking note permission was not possible; a nonexistent audit lead fails in preflight instead. The `partial_success` / `trace_repair` path is covered only by mocked tests.
8. **Unverified list — walked** (see "API contract status"): conversion key, activity time format, address PATCH, v2 end markers, archive reason (not required here), nested deal search objects, envelopes.
