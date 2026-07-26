# HR Triage Notion Connector + Skill Spec

## Problem

An existing webhook-triggered LangGraph workflow triages job applications.

Yoplai needs an equivalent manual HR-agent workflow. The replacement should not port the LangGraph graph as one opaque connector tool. Instead, Yoplai should provide a reusable generic Notion connector, and the HR agent should use a skill that describes how to orchestrate triage with its own model.

## Goals

- Add a generic `notion` connector usable by multiple Yoplai agents.
- Expose low-level Notion tools so agents can navigate databases, pages, blocks, and files freely.
- Include a resume extraction tool for Notion-hosted PDF/DOCX files.
- Add an HR skill that tells the agent how to find untriaged applications and triage them.
- Preserve the old workflow's conservative assessment policy:
  - reject only clear disqualifiers
  - default ambiguous cases to `review`
  - use `hot`, `review`, `rejected`, and `AI processing` labels exactly
- Manual use only. Example request: "Can you triage the recent applications?"
- Write Notion updates directly, one application at a time, sequentially.

## Non-Goals

- No webhook automation in this slice.
- No scheduler or polling loop.
- No LangGraph runtime port.
- No Langfuse dependency in Yoplai.
- No batching or parallel writes to Notion.
- No HR-specific connector API.
- No hardcoded applications database ID in the skill.

## Connector Scope

Connector ID: `notion`

The connector should be generic, not HR-specific. It should authenticate with a Notion integration token and expose reusable primitives.

### Config

Required config:

- `apiKey`: Notion integration token.

Optional config:

- `notionVersion`: default to the API version used by the old workflow if supported, otherwise the current stable version selected during implementation.
- `timeoutMs`: default around 30000.

Required secret keys:

- `apiKey`

### Tools

MVP tool set:

- `list_data_sources`
  - List/search data sources available to the integration.
  - Used by agents to discover the right database/data source from user language.

- `get_data_source`
  - Fetch one data source schema and metadata.
  - Returns properties, description, title, and IDs.

- `update_data_source`
  - Patch data source properties.
  - Needed so the HR skill can create or repair `AI Tags` and `AI Note`.

- `query_data_source`
  - Query pages in a data source.
  - Accepts Notion filter/sort/page-size payloads.
  - Returns page summaries plus pagination metadata.

- `get_page`
  - Fetch page properties and parent metadata.

- `update_page_properties`
  - Patch page properties by property ID or name, depending on final schema.
  - Must support rich text and multi-select updates.

- `get_blocks`
  - Fetch page/block children.
  - Should handle pagination or expose cursor parameters.

- `append_blocks`
  - Append children to a page/block.
  - Needed for resume summary and AI assessment blocks.

- `delete_block`
  - Delete/archive a block.
  - Needed for idempotent replacement of old AI-generated sections.

- `download_and_extract_file`
  - Download a Notion file/external file URL and extract text.
  - Supports PDF and DOCX.
  - Returns extracted text plus source metadata.

- `validate`
  - Validate token/config and basic API reachability.

All tool `parameters` must be `z.object({ ... })`.

## Skill Scope

Skill name: likely `hr-application-triage`.

Skill location: save in the HR agent workspace where Yoplai can load it. Current Yoplai docs prefer `{agent_workspace}/agent/skills/`, but runtime also loads `{workspace}/skills`; the implementation should account for this mismatch.

The skill should describe the manual triage procedure and reference the `notion` connector tools.

## HR Triage Workflow

### 1. Resolve Target Data Source

When the user asks to triage applications:

- Use `notion.list_data_sources` and/or `notion.query_data_source` to find the relevant applications database/data source based on user wording.
- Do not rely on a hardcoded database ID.
- If multiple plausible databases exist, ask the user to choose.

### 2. Ensure Triage Schema

Fetch the data source schema with `notion.get_data_source`.

Ensure:

- `AI Note` exists as rich text.
- `AI Tags` exists as multi-select.
- `AI Tags` contains exactly these workflow status options if absent:
  - `AI processing`
  - `hot`
  - `review`
  - `rejected`

If missing/incomplete, use `notion.update_data_source` to create or repair them.

Property matching should be case-insensitive and space-insensitive.

### 3. Find Applications To Triage

Default behavior:

- Triage every database entry where both `AI Tags` and `AI Note` are missing or empty.
- Process entries sequentially.

Stage behavior:

- If the database has a `Stage` property and the user asks for new/unprocessed applications, skip entries where `Stage` is non-empty.
- If the user explicitly asks to triage a specific page, do not skip solely because `Stage` is set; mention the existing stage before/while updating.

### 4. Mark Processing

Before assessing one application:

- Add `AI processing` to `AI Tags`.
- Do not process multiple applications in parallel.

### 5. Gather Candidate Inputs

For each page:

- Fetch page properties with `notion.get_page`.
- Fetch page blocks with `notion.get_blocks` to capture application answers/Q&A.
- Locate resume input:
  - prefer file attachments in `Resume`, `CV`, or `Resumes`
  - fallback to URL-like properties such as `Upload your resume`
- Use `notion.download_and_extract_file` for PDF/DOCX resume content.
- Capture optional fields when present:
  - candidate location
  - LinkedIn URL
  - AssessFirst URL
  - case study answers

Property matching should support the old workflow synonyms:

- resume: `resume`, `cv`, `resumes`
- resume URL: `uploadyourresume`
- LinkedIn: `linkedin`, `linkedinprofile`
- case study: `casestudy`, `casestudyanalysis`, `casestudynanalysis`

### 6. Gather Job Requirements

Use the best available source:

1. Data source description.
2. A job-description page in the same database where:
   - `Stage` is non-empty, and
   - `Last Name` contains `Job description`.
3. User-provided instructions in the current request.

If no requirements are available, proceed with `review` rather than failing.

### 7. Hard Checks

Case study:

- If a case study property exists but answers are empty, classify as `rejected`.
- AI Note: `Case study answers not provided`.

AssessFirst:

- A valid URL matching `https://my.assessfirst.com/public/profile/...` is a positive signal.
- Missing/invalid AssessFirst is neutral, not a rejection reason.

Mandatory requirements:

- Identify explicit hard requirements only.
- Reject only if the candidate clearly misses a mandatory requirement.
- Do not reject on soft preferences or ambiguous wording.
- Give the candidate benefit of the doubt.

Strict requirements must be explicit in candidate material:

- native/mother-tongue language requirements
- required certifications
- minimum years of experience

Inference rules:

- If a CV is written in a language, infer at least B2 proficiency in that language.
- Accept adjacent technical skills/domains when reasonable.
- IT Support, Service Desk, Technical Account Management, and similar roles count as customer-facing technical experience.
- Managing teams at international companies can support multicultural team experience.
- Prefer domain expertise over exact vendor/product names unless the requirement is explicitly strict.

### 8. Generate Summary

Create 5-8 concise, factual bullets from the resume:

- years of experience and seniority
- key skills and expertise
- notable achievements or credentials
- role types and responsibilities

If no resume is available or extraction fails, classify as `review` and explain why in `AI Note`.

### 9. Pre-Assess Candidate

Classify:

- `hot`: strong match on core requirements, proceed immediately.
- `review`: partial match, adjacent experience, transferable skills, unclear case, or potential fit.
- `rejected`: only clear disqualifiers or obvious mismatch.

Default to `review`.

AssessFirst completion should be treated as a positive signal when present.

### 10. Update Notion

For each application, update Notion directly:

- Remove any workflow status tags from `AI Tags`.
- Add exactly one final tag: `hot`, `review`, or `rejected`.
- Write concise reasoning into `AI Note`.
- Replace old AI-generated content blocks, then append:
  - heading `Resume Summary`
  - bullet list of summary points
  - heading `AI Assessment`
  - bullet list of assessment points

The old workflow deleted headings named `AI Summary` or `AI Assessment`; the new skill should be explicit about whichever heading names implementation chooses, so reruns are idempotent.

## User Stories

- As an HR user, I can ask the HR agent to triage untriaged applications and have Notion updated.
- As an HR user, I can ask the HR agent to triage a specific candidate page.
- As an HR user, I can trust the agent not to reject borderline candidates too aggressively.
- As another Yoplai agent owner, I can reuse the same generic Notion connector for non-HR workflows.

## Error Handling

- Missing/invalid Notion token: connector `validate` fails clearly.
- Missing data source: ask the user to identify the right database.
- Multiple plausible data sources: ask user to choose.
- Missing `AI Tags`/`AI Note`: create or repair with `update_data_source`.
- Resume extraction failure: set candidate to `review`, explain in `AI Note`.
- LLM uncertainty: choose `review`.
- Notion write failure: stop current candidate and report; do not continue silently with later candidates unless user asks.

## Security

- Notion token must come from Yoplai connector config/secrets.
- Do not expose token values in tool outputs or skill text.
- Connector should return JSON-serializable data only.
- Keep connector generic; do not embed HR prompt text or private database IDs.

## Testing Requirements

Connector tests should cover:

- connector metadata and required secrets
- every tool has `z.object` parameters
- config validation
- Notion API auth headers and version header
- data source query/get/update request shapes
- page/block update request shapes
- pagination behavior
- 401/403/404/429/5xx handling
- PDF extraction success/failure
- DOCX extraction success/failure

Skill validation should be manual or fixture-based:

- untriaged detection requires both `AI Tags` and `AI Note` empty
- schema creation/repair instructions are present
- sequential processing is explicit
- conservative rejection policy is explicit
- direct Notion write policy is explicit

## Open Questions

- Exact Yoplai HR agent workspace path.
- Whether the connector should normalize Notion property names internally or leave that entirely to the skill/agent.
- Which package to use for PDF/DOCX extraction in TypeScript.
- Whether to support Notion database APIs and data source APIs both, depending on active Notion API version.
