import { z } from "zod";

import { PipedriveWriteClient } from "./write-client.js";
import {
  DealDetailSchema,
  ListDealsResultSchema,
  OrganizationDetailSchema,
  SearchDealsResultSchema,
  SearchLeadsResultSchema,
  ListDealFilesResultSchema,
  PersonDetailSchema,
  DownloadFileParamsSchema,
  GetActivityParamsSchema,
  GetDealFieldParamsSchema,
  GetDealParamsSchema,
  GetLeadParamsSchema,
  GetOrganizationParamsSchema,
  GetPersonParamsSchema,
  GetPipelineParamsSchema,
  GetStageParamsSchema,
  ListContactFieldsParamsSchema,
  ListDealActivitiesParamsSchema,
  ListDealDiscountsParamsSchema,
  ListDealFieldsParamsSchema,
  ListDealFilesParamsSchema,
  ListDealNotesParamsSchema,
  ListDealProductsParamsSchema,
  ListDealsParamsSchema,
  ListLeadActivitiesParamsSchema,
  ListLeadNotesParamsSchema,
  ListLeadsParamsSchema,
  ListPipelinesParamsSchema,
  ListStagesParamsSchema,
  PipedriveConfigSchema,
  SearchDealsParamsSchema,
  SearchLeadsParamsSchema,
  SearchOrganizationsParamsSchema,
  SearchPersonsParamsSchema,
} from "./models.js";
import {
  ConvertLeadToDealParamsSchema,
  CreateActivityParamsSchema,
  CreateDealParamsSchema,
  CreateLeadLabelParamsSchema,
  CreateLeadParamsSchema,
  CreateNoteParamsSchema,
  CreateOrganizationParamsSchema,
  CreatePersonParamsSchema,
  UpdateActivityParamsSchema,
  UpdateDealParamsSchema,
  UpdateLeadLabelParamsSchema,
  UpdateLeadParamsSchema,
  UpdateOrganizationParamsSchema,
  UpdatePersonParamsSchema,
} from "./write-models.js";
import { defineToolExtension, type ToolExtensionTool } from "../tool-extension.js";

const RefreshFieldRegistryParamsSchema = z.object({}).strict();
const ValidateParamsSchema = z.object({}).strict();
const ListLeadLabelsParamsSchema = z.object({}).strict();
const ListLeadSourcesParamsSchema = z.object({}).strict();
const ListUsersParamsSchema = z.object({}).strict();
const ListActivityTypesParamsSchema = z.object({}).strict();

const WRITE_GUIDANCE = `Pipedrive is READ-ONLY by default. The write tools (pipedrive_create_*, pipedrive_update_*, pipedrive_convert_lead_to_deal) and the supporting reads pipedrive_search_persons, pipedrive_search_organizations, pipedrive_list_contact_fields, pipedrive_get_activity and pipedrive_list_activity_types exist only when allowWrite is enabled for this agent. If they are not in your tool list, diagnose and propose changes but never claim an update was applied.

When the write tools are available:
1. Read the record first (pipedrive_get_lead / get_deal / get_person with output_type "full" / get_organization with output_type "full") and resolve ids, owners (pipedrive_list_users), lead labels and custom-field options.
2. Search before creating and reuse what exists. Creates run their own duplicate check: a duplicate_candidates result means NOTHING was created — pick an existing record or supply distinguishing data. There is no force option; never work around it.
3. For creates, field edits, owner changes, archiving, conversion and label-definition changes show the human the exact before→after and the affected records, get an explicit OK, and only then set confirmed: true. A batch approval covers only the listed records and changes (typically up to ~20, each as its own call). Stop the batch on any conflict, unknown outcome or audit failure and report what was completed.
4. Updates need changes plus expected_before with the current value of EVERY changed field. A conflict result means someone changed the record — nothing was written; re-read, re-show the diff and obtain renewed approval.
5. requested_by is the human who asked (from the conversation; ask if unknown). Never use the agent name, the record owner or the shared token owner.
6. Notes and routine activity logging (pipedrive_create_note, create_activity, update_activity) may proceed without extra approval when directly requested; assigning/changing an activity owner needs confirmed: true. The tool adds the agent marker itself.
7. Never delete or merge. Archive with update_lead is_archived: true. Flag suspected duplicates with a note naming the duplicate ids (and optionally an existing "Possible duplicate" label via update_lead); never merge.
8. Lists such as label_ids, emails, phones and set fields are full replacements: include every entry to keep. null clears only where allowed. VAT/SIREN are organization custom fields (custom_fields, see pipedrive_list_contact_fields).
9. Report outcomes accurately: applied, unchanged, reused, conflict, duplicate_candidates, pending (conversion — resume with its conversion_id, never start it again) and partial success (applied but trace_status failed/unknown — repair with pipedrive_create_note using trace_repair, or, when trace_repair is null on a conversion, resume with its conversion_id; never repeat the change).
10. confirmed: true is not verified by the tool; it records that the human approved.`;

export default defineToolExtension({
  id: "pipedrive",
  displayName: "Pipedrive",
  description:
    "Pipedrive data access for the sales pipeline, read-only by default: token-bounded deal retrieval with server-side filters and an expected-close-date range narrowing. Optional confirmed record changes (leads, deals, persons, organizations, notes, activities, lead labels, lead conversion) when allowWrite is enabled.",
  configFieldTitles: { allowWrite: "Enable creating and updating CRM records" },
  systemPrompt: `Use this extension to read the Pipedrive sales pipeline. ${WRITE_GUIDANCE}

pipedrive_list_deals returns a lean, token-bounded projection — narrow the pipeline with server-side filters (status, pipeline_id, stage_id, person_id, org_id, user_id) and the expected_close_from / expected_close_to date range (YYYY-MM-DD) rather than pulling every deal. status defaults to "open"; "all" means no status filter and returns all non-deleted deals. "deleted" lists deals deleted in the last 30 days. sort_by accepts id, update_time (default), add_time, or won_time. A won_time sort applies inside each returned page (including all upstream pages joined by a date filter), with nulls last, not globally across cursor calls. For deals WON in a given period, filter by won date with won_from / won_to (compared against each deal's won_time) and set status to "won" — the expected close date is NOT the won date, so never use expected_close_* to answer "won in month X". Every returned deal includes won_time. To page through a large filtered result, pass the returned next_cursor back as cursor until next_cursor is null; every deal is returned exactly once with no gaps or duplicates.

pipedrive_search_deals does free-text title search (e.g. term "try & buy" to flag Try-and-Buy deals for invoicing exclusion) with optional status/person_id/org_id filters. Search status accepts open, won, lost, or all; omitted status or "all" means no filter and returns all non-deleted deals. Both deal tools accept legacy all_not_deleted as all. pipedrive_list_deal_notes and pipedrive_list_deal_activities read a single deal's notes (with author/timestamp) and activity history. These use the same next_cursor pagination — page until next_cursor is null.

To resolve a deal's linked entities for an invoice customer: pass the deal's org_id to pipedrive_get_organization (name, address, VAT/SIREN when stored) and its person_id to pipedrive_get_person (contact name + emails/phones). Guard against a deal with no linked org/person: when org_id or person_id is null, do not call these ops — there is nothing to resolve. A missing entity id surfaces as a typed not-found error.

Pipeline & stage metadata: pipedrive_list_pipelines / pipedrive_get_pipeline and pipedrive_list_stages / pipedrive_get_stage (optional pipeline_id filter) resolve stage/pipeline names — use them to detect stages like "Final negotiation" / "Won". Deal line items: pipedrive_list_deal_products returns each product's quantity, unit price (item_price) and billing_frequency (the source for devis amounts and recurring MRR/ARR products). pipedrive_list_deal_discounts returns deal-level discounts. All list ops use the same cursor pagination — page with next_cursor until it is null.

To work with a deal's attachments (e.g. the sales-uploaded Excel/doc that holds the sale info): call pipedrive_list_deal_files with a deal_id to see each file's name, type, and size, pick the right file, then call pipedrive_download_file with its file_id. download_file returns the RAW bytes base64-encoded (content_base64) — the extension never parses or transforms the file. Decode and parse it downstream in your workflow. A file with a non-null remote_location (e.g. "googledocs") is hosted externally — download_file returns a typed error with the external link instead of bytes; surface that link to the user rather than retrying.

pipedrive_get_deal reads one deal in full detail: all standard fields plus custom fields resolved to human-readable labels and typed values (never raw hash keys). output_type "full" (default) includes normalized_extra_fields + normalized_field_metadata; "lean" strips them. Custom-field schema is available via pipedrive_list_deal_fields / pipedrive_get_deal_field (key → label/options/type, v1 offset pagination via start/limit) — use these for invoice mapping and required-field logic. Field metadata is cached locally; pipedrive_refresh_field_registry forces a rebuild if the schema changed.

For the Leads inbox (separate from the deals pipeline): pipedrive_list_leads lists leads with a lean projection, filterable by archived_status (default "not_archived"), owner_id, person_id, organization_id, and filter_id — page with next_cursor until it is null. pipedrive_get_lead reads one lead in full detail by its UUID id, with custom fields normalized the same way as get_deal (leads share the deal custom-field schema); output_type "full" (default) includes normalized_extra_fields + normalized_field_metadata, "lean" strips them. pipedrive_search_leads does free-text search across title/notes/custom_fields (set via the fields param). Use pipedrive_list_lead_labels and pipedrive_list_lead_sources to resolve a lead's label_ids and source_name to human-readable names. pipedrive_list_lead_notes and pipedrive_list_lead_activities read a lead's notes and activity history (activities via the v2 API) — same next_cursor pagination as the deal ops. A lead's person_id / organization_id resolve via the existing pipedrive_get_person / pipedrive_get_organization. Note: Pipedrive's API exposes no email threads or changelog for leads — history is limited to notes and activities.

To read custom fields (e.g. "Forecast category") across many deals, pass custom_fields: ["Forecast category", ...] to pipedrive_list_deals: one paged list call returns them per deal with readable values — never loop pipedrive_get_deal for this. Every listed deal also carries local_won_date and local_close_date.\n\nDeals from pipedrive_list_deals and pipedrive_get_deal include owner_name (the owner's display name) next to user_id. pipedrive_list_users lists every user (id, name, email, active) to resolve any other owner/user id to a name.

pipedrive_validate verifies auth and API reachability.`,
  configSchema: PipedriveConfigSchema,
  requiredSecrets: ["apiToken"],
  createTools(config) {
    const resolved = PipedriveConfigSchema.parse(config.merged);
    const client = new PipedriveWriteClient(resolved);

    const readTools: ToolExtensionTool[] = [
      {
        name: "validate",
        description: "Validate Pipedrive auth and API reachability via users/me.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
      {
        name: "list_deals",
        description:
          "List deals from the Pipedrive pipeline with a lean per-deal projection (now including won_time). Supports server-side filters (status [default open; all omits the filter for all non-deleted deals; deleted covers the last 30 days], pipeline_id, stage_id, person_id, org_id, user_id), an expected-close-date range (expected_close_from / expected_close_to, YYYY-MM-DD), and a won-date range (won_from / won_to, YYYY-MM-DD, filters on won_time). sort_by accepts id, update_time (default), add_time, or won_time; won_time sorts all deals inside each returned page only, with nulls last, not globally across cursor calls. Optional custom_fields (names like 'Forecast category' or hash keys, max 15) adds those fields per deal with readable values. Returns { deals, next_cursor, count }; pass next_cursor back as cursor to page through the full filtered result.",
        parameters: ListDealsParamsSchema,
        outputSchema: ListDealsResultSchema,
        execute: async (params) => {
          const parsed = ListDealsParamsSchema.parse(params);
          return await client.listDeals(parsed);
        },
      },
      {
        name: "list_deal_files",
        description:
          "List the files/attachments on a deal with a lean metadata projection so you can pick the right one. Returns { files, count } where each file has { id, name, type, size (bytes), deal_id, add_time, url, remote_location }. Returns up to 500 files (deals rarely have more). Read-only; nothing is downloaded or parsed. Pass a file's id to download_file to fetch its bytes — but if remote_location is non-null (e.g. \"googledocs\"), the file is hosted externally and download_file will return a typed error with the link instead.",
        parameters: ListDealFilesParamsSchema,
        outputSchema: ListDealFilesResultSchema,
        execute: async (params) => {
          const parsed = ListDealFilesParamsSchema.parse(params);
          return await client.listDealFiles(parsed);
        },
      },
      {
        name: "download_file",
        description:
          "Download a deal file's RAW bytes by file_id — content is NOT parsed or transformed. Return shape (decided for this extension): the bytes are base64-encoded in content_base64 rather than saved to a workspace path, so the result is self-contained and binary formats (e.g. .xlsx) round-trip through JSON with byte integrity intact. Returns { file_id, name, mime_type, size (exact byte length), encoding: 'base64', content_base64 }. Decode and parse downstream in your workflow.",
        parameters: DownloadFileParamsSchema,
        execute: async (params) => {
          const parsed = DownloadFileParamsSchema.parse(params);
          return await client.downloadFile(parsed);
        },
      },
      {
        name: "list_pipelines",
        description:
          "List pipelines (v2) with a lean projection (id, name, order_nr, active). Returns { pipelines, next_cursor, count }; pass next_cursor back as cursor to page through all pipelines.",
        parameters: ListPipelinesParamsSchema,
        execute: async (params) => {
          const parsed = ListPipelinesParamsSchema.parse(params);
          return await client.listPipelines(parsed);
        },
      },
      {
        name: "get_pipeline",
        description: "Fetch a single pipeline by pipeline_id (v2), returning its metadata (name, order_nr, active).",
        parameters: GetPipelineParamsSchema,
        execute: async (params) => {
          const parsed = GetPipelineParamsSchema.parse(params);
          return await client.getPipeline(parsed.pipeline_id);
        },
      },
      {
        name: "list_stages",
        description:
          "List stages (v2) with a lean projection (id, name, pipeline_id, order_nr, deal_probability) and an optional server-side pipeline_id filter. Returns { stages, next_cursor, count }; page with next_cursor.",
        parameters: ListStagesParamsSchema,
        execute: async (params) => {
          const parsed = ListStagesParamsSchema.parse(params);
          return await client.listStages(parsed);
        },
      },
      {
        name: "get_stage",
        description: "Fetch a single stage by stage_id (v2), returning its metadata (name, pipeline_id, order_nr, deal_probability).",
        parameters: GetStageParamsSchema,
        execute: async (params) => {
          const parsed = GetStageParamsSchema.parse(params);
          return await client.getStage(parsed.stage_id);
        },
      },
      {
        name: "list_deal_products",
        description:
          "List a deal's attached products / line items (v2 /deals/{id}/products) — name, quantity, unit price (item_price), billing_frequency, tax, discount and variation. The source for devis amounts and recurring MRR/ARR products. Returns { deal_id, products, next_cursor, count }; page with next_cursor.",
        parameters: ListDealProductsParamsSchema,
        execute: async (params) => {
          const parsed = ListDealProductsParamsSchema.parse(params);
          return await client.listDealProducts(parsed);
        },
      },
      {
        name: "list_deal_discounts",
        description:
          "List a deal's deal-level discounts (v2 /deals/{id}/discounts) — id, description, amount, type. Returns { deal_id, discounts, next_cursor, count }; page with next_cursor.",
        parameters: ListDealDiscountsParamsSchema,
        execute: async (params) => {
          const parsed = ListDealDiscountsParamsSchema.parse(params);
          return await client.listDealDiscounts(parsed);
        },
      },
      {
        name: "get_deal",
        description:
          "Read a single deal in full detail by deal_id. Returns all standard fields (title, value, currency, status, stage/pipeline, person/org/owner, expected close date, created/updated/won times) plus a deal URL. Custom fields resolve to human-readable labels and typed values (enum→label, set→[labels], monetary→{amount,currency}, date-range→{from,until}) — never raw hash keys. output_type 'full' (default) includes normalized_extra_fields + normalized_field_metadata; 'lean' strips them.",
        parameters: GetDealParamsSchema,
        outputSchema: DealDetailSchema,
        execute: async (params) => {
          const parsed = GetDealParamsSchema.parse(params);
          return await client.getDeal(parsed);
        },
      },
      {
        name: "list_deal_fields",
        description:
          "List Pipedrive custom-field (dealField) definitions — the schema needed for invoice mapping and required-field logic. Each field carries key → name/field_type/options (enum/set) plus flags. Uses v1 offset pagination: pass start/limit and follow pagination.next_start while pagination.more_items_in_collection is true.",
        parameters: ListDealFieldsParamsSchema,
        execute: async (params) => {
          const parsed = ListDealFieldsParamsSchema.parse(params);
          return await client.listDealFields(parsed);
        },
      },
      {
        name: "get_deal_field",
        description:
          "Get a single custom-field (dealField) definition by numeric field_id, including its key, name, field_type, and options.",
        parameters: GetDealFieldParamsSchema,
        execute: async (params) => {
          const parsed = GetDealFieldParamsSchema.parse(params);
          return await client.getDealField(parsed);
        },
      },
      {
        name: "refresh_field_registry",
        description:
          "Force a rebuild of the locally-cached custom-field registry from the Pipedrive API. Use after the deal-field schema changes so subsequent get_deal calls resolve the latest labels/options.",
        parameters: RefreshFieldRegistryParamsSchema,
        execute: async () => {
          return await client.refreshFieldRegistry();
        },
      },
      {
        name: "get_organization",
        description:
          "Resolve a deal's org_id to the organization entity for an invoice customer: { id, name, address, vat, siren, org_url }. address is structured (formatted_address + parts) or null; vat/siren are null unless stored on the org. output_type \"full\" additionally returns owner_id, add/update time and normalized custom fields + metadata (use before update_organization). Throws a typed not-found error when the organization does not exist.",
        parameters: GetOrganizationParamsSchema,
        outputSchema: OrganizationDetailSchema,
        execute: async (params) => {
          const parsed = GetOrganizationParamsSchema.parse(params);
          return await client.getOrganization(parsed.id, parsed.output_type);
        },
      },
      {
        name: "get_person",
        description:
          "Resolve a deal's person_id to the primary contact entity: { id, name, first_name, last_name, job_title, org_id, emails, phones, primary_email, primary_phone, person_url }. emails/phones are labelled with a primary flag. output_type \"full\" additionally returns owner_id, add/update time and normalized custom fields + metadata (use before update_person). Throws a typed not-found error when the person does not exist.",
        parameters: GetPersonParamsSchema,
        outputSchema: PersonDetailSchema,
        execute: async (params) => {
          const parsed = GetPersonParamsSchema.parse(params);
          return await client.getPerson(parsed.id, parsed.output_type);
        },
      },
      {
        name: "search_deals",
        description:
          'Free-text search on deal titles. Pass a term (e.g. "try & buy" to flag Try-and-Buy deals for invoicing exclusion) plus optional server-side filters (status, person_id, org_id, exact_match). Status accepts open, won, lost, or all; omitted status or all means no filter and returns all non-deleted deals. Returns { deals, next_cursor, count } with a lean per-match projection; pass next_cursor back as cursor to page the full match set so no matching deal is missed.',
        parameters: SearchDealsParamsSchema,
        outputSchema: SearchDealsResultSchema,
        execute: async (params) => {
          const parsed = SearchDealsParamsSchema.parse(params);
          return await client.searchDeals(parsed);
        },
      },
      {
        name: "list_deal_notes",
        description:
          "Read a deal's notes (content, author, add/update timestamps) for a given deal_id — e.g. to confirm a PO exists. Returns { notes, next_cursor, count }; pass next_cursor back as cursor to page through all notes.",
        parameters: ListDealNotesParamsSchema,
        execute: async (params) => {
          const parsed = ListDealNotesParamsSchema.parse(params);
          return await client.listDealNotes(parsed);
        },
      },
      {
        name: "list_deal_activities",
        description:
          "Read a deal's activity history (type, subject, done, due/completion timestamps, owner) for a given deal_id — e.g. to understand why a deal stalled. Optional done filter. Returns { activities, next_cursor, count }; pass next_cursor back as cursor to page through the full history.",
        parameters: ListDealActivitiesParamsSchema,
        execute: async (params) => {
          const parsed = ListDealActivitiesParamsSchema.parse(params);
          return await client.listDealActivities(parsed);
        },
      },
      {
        name: "list_leads",
        description:
          'List leads from the Pipedrive Leads inbox with a lean per-lead projection. Supports server-side filters (archived_status ["archived" | "not_archived" | "all"], default "not_archived", owner_id, person_id, organization_id, filter_id) and sort. Returns { leads, next_cursor, count }; pass next_cursor back as cursor to page through the full filtered result.',
        parameters: ListLeadsParamsSchema,
        execute: async (params) => {
          const parsed = ListLeadsParamsSchema.parse(params);
          return await client.listLeads(parsed);
        },
      },
      {
        name: "get_lead",
        description:
          "Read a single lead in full detail by its UUID id. Returns all standard fields (title, owner, labels, person/org, source, value, expected close date, timestamps, visibility) plus a leads-inbox URL. Custom fields resolve to human-readable labels and typed values, same as get_deal (leads share the deal custom-field schema). output_type 'full' (default) includes normalized_extra_fields + normalized_field_metadata; 'lean' strips them.",
        parameters: GetLeadParamsSchema,
        execute: async (params) => {
          const parsed = GetLeadParamsSchema.parse(params);
          return await client.getLead(parsed);
        },
      },
      {
        name: "search_leads",
        description:
          'Free-text search over leads. Pass a term (min 2 chars) plus optional fields (comma list: "title", "notes", "custom_fields"), exact_match, person_id, organization_id, and include_fields. Returns { leads, next_cursor, count } with a lean per-match projection (owner/person/organization as {id, name}); pass next_cursor back as cursor to page the full match set.',
        parameters: SearchLeadsParamsSchema,
        outputSchema: SearchLeadsResultSchema,
        execute: async (params) => {
          const parsed = SearchLeadsParamsSchema.parse(params);
          return await client.searchLeads(parsed);
        },
      },
      {
        name: "list_lead_labels",
        description:
          "List all lead labels ({ id, name, color, add_time, update_time }) — use to resolve a lead's label_ids to human-readable names. Returns { labels, count }. No pagination.",
        parameters: ListLeadLabelsParamsSchema,
        execute: async () => {
          return await client.listLeadLabels();
        },
      },
      {
        name: "list_users",
        description:
          "List all Pipedrive users ({ id, name, email, active }), including deactivated ones — use to resolve owner/user ids (deal user_id, lead owner_id, activity user_id) to names. Returns { users, count }. No pagination.",
        parameters: ListUsersParamsSchema,
        execute: async () => {
          return await client.listUsers();
        },
      },
      {
        name: "list_lead_sources",
        description:
          "List all lead sources ({ name }) — use to cross-check a lead's source_name. Returns { sources, count }. No pagination.",
        parameters: ListLeadSourcesParamsSchema,
        execute: async () => {
          return await client.listLeadSources();
        },
      },
      {
        name: "list_lead_notes",
        description:
          "Read a lead's notes (content, author, add/update timestamps) for a given lead_id (UUID). Returns { notes, next_cursor, count }; pass next_cursor back as cursor to page through all notes.",
        parameters: ListLeadNotesParamsSchema,
        execute: async (params) => {
          const parsed = ListLeadNotesParamsSchema.parse(params);
          return await client.listLeadNotes(parsed);
        },
      },
      {
        name: "list_lead_activities",
        description:
          "Read a lead's activity history (type, subject, done, due/completion timestamps, owner) for a given lead_id (UUID), via the v2 activities API. Optional done filter. Returns { activities, next_cursor, count }; pass next_cursor back as cursor to page through the full history.",
        parameters: ListLeadActivitiesParamsSchema,
        execute: async (params) => {
          const parsed = ListLeadActivitiesParamsSchema.parse(params);
          return await client.listLeadActivities(parsed);
        },
      },
    ];
    if (resolved.allowWrite !== true) return readTools;

    const tool = <T extends z.ZodTypeAny>(
      name: string,
      description: string,
      parameters: T,
      run: (params: z.infer<T>) => Promise<unknown>,
    ): ToolExtensionTool => ({
      name,
      description,
      parameters,
      execute: async (params) => run(parameters.parse(params)),
    });

    return [
      ...readTools,
      tool(
        "search_persons",
        "Free-text person search (v2) by name/email/phone/notes/custom fields (fields param), optional exact_match and organization_id. Use before create_person. Returns { persons: [{ id, name, emails, phones, org_id, org_name }], next_cursor, count }; page with next_cursor.",
        SearchPersonsParamsSchema,
        (params) => client.searchPersons(params),
      ),
      tool(
        "search_organizations",
        "Free-text organization search (v2) by name/address/notes/custom fields (fields param), optional exact_match. Use before create_organization (also to find an org by VAT/SIREN with fields custom_fields). Returns { organizations: [{ id, name, address }], next_cursor, count }.",
        SearchOrganizationsParamsSchema,
        (params) => client.searchOrganizations(params),
      ),
      tool(
        "list_contact_fields",
        "List person or organization custom-field definitions (entity person|organization; key → name/type/options). Use to find exact keys and option labels (e.g. VAT, SIREN) for custom_fields on person/organization writes. v1 offset pagination via start/limit.",
        ListContactFieldsParamsSchema,
        (params) => client.listContactFields(params),
      ),
      tool(
        "get_activity",
        "Read one activity by id (v2): type, subject, note, done, due date/time, duration, owner and linked lead/deal/person/org. Use before update_activity.",
        GetActivityParamsSchema,
        (params) => client.getActivity(params),
      ),
      tool(
        "list_activity_types",
        "List activity types ({ id, name, key_string, active }); use key_string as the type for create_activity / update_activity.",
        ListActivityTypesParamsSchema,
        () => client.listActivityTypes(),
      ),
      tool(
        "create_lead",
        "HARD CONFIRMATION. Create a lead (v1). Needs title and at least one of person_id / organization_id; optional owner_id, label_ids, value {amount,currency}, expected_close_date, custom_fields. Searches existing leads (incl. archived) first: a duplicate_candidates result means nothing was created. Writes a 'Created by agent' trace note. Requires requested_by and confirmed: true after human approval.",
        CreateLeadParamsSchema,
        (params) => client.createLead(params),
      ),
      tool(
        "update_lead",
        "HARD CONFIRMATION. Update a lead (v1 PATCH): title, value, expected_close_date, owner_id, label_ids (full replacement), person_id/organization_id (cannot remove both), is_archived (archive/unarchive; never deletes), custom_fields. Pass changes plus expected_before (current value of every changed field); a conflict result means nothing was written. Leaves a trace note listing before→after. Requires requested_by and confirmed: true.",
        UpdateLeadParamsSchema,
        (params) => client.updateLead(params),
      ),
      tool(
        "create_deal",
        "HARD CONFIRMATION. Create a deal (v2). Needs title; optional person_id, org_id, owner_id, stage_id/pipeline_id (stage must belong to the pipeline), value, currency, expected_close_date, custom_fields. Searches same-title deals first (duplicate_candidates = nothing created). Writes a 'Created by agent' trace note. Requires requested_by and confirmed: true.",
        CreateDealParamsSchema,
        (params) => client.createDeal(params),
      ),
      tool(
        "update_deal",
        "HARD CONFIRMATION. Update a deal (v2 PATCH): title, value/currency, stage_id/pipeline_id (a pipeline change needs a stage of it), expected_close_date (can be set, not cleared), status open|won|lost (+ lost_reason with lost; never deleted), owner_id, person_id, org_id, custom_fields. Pass changes plus expected_before for every changed field; conflict = nothing written. Leaves a trace note. Requires requested_by and confirmed: true.",
        UpdateDealParamsSchema,
        (params) => client.updateDeal(params),
      ),
      tool(
        "create_person",
        "HARD CONFIRMATION. Create a person (v2). Needs name; optional org_id, owner_id, emails, phones ({value,label?,primary?}), custom_fields. Searches by every email, phone and the name first (duplicate_candidates = nothing created; link the existing person instead). Writes a 'Created by agent' trace note. Requires requested_by and confirmed: true.",
        CreatePersonParamsSchema,
        (params) => client.createPerson(params),
      ),
      tool(
        "update_person",
        "HARD CONFIRMATION. Update a person (v2 PATCH): name, org_id (null unlinks), owner_id, emails/phones (full replacement lists), custom_fields. Read with get_person output_type full first; pass changes plus expected_before for every changed field. Leaves a trace note. Requires requested_by and confirmed: true.",
        UpdatePersonParamsSchema,
        (params) => client.updatePerson(params),
      ),
      tool(
        "create_organization",
        "HARD CONFIRMATION. Create an organization (v2). Needs name; optional owner_id, address {value,...}, custom_fields (VAT/SIREN are custom fields). Searches by name and by VAT/SIREN values first (duplicate_candidates = nothing created). Writes a 'Created by agent' trace note. Requires requested_by and confirmed: true.",
        CreateOrganizationParamsSchema,
        (params) => client.createOrganization(params),
      ),
      tool(
        "update_organization",
        "HARD CONFIRMATION. Update an organization (v2 PATCH): name, owner_id, address (full replacement; compared by formatted line and each component), custom_fields incl. VAT/SIREN. Read with get_organization output_type full first; pass changes plus expected_before for every changed field. Leaves a trace note. Requires requested_by and confirmed: true.",
        UpdateOrganizationParamsSchema,
        (params) => client.updateOrganization(params),
      ),
      tool(
        "create_note",
        "SOFT CONFIRMATION. Add a note to exactly one of lead_id, deal_id, person_id, org_id. Content is plain text (HTML-escaped); the tool adds the '[Agent-made for <requested_by>]' marker. An identical existing note is reused (returns its id), so this is also how to repair a missing trace note. Requires requested_by.",
        CreateNoteParamsSchema,
        (params) => client.createNote(params),
      ),
      tool(
        "create_activity",
        "SOFT CONFIRMATION (owner assignment is hard: confirmed: true). Create an activity (v2) linked to a lead/deal/person/org with subject, type (see list_activity_types), optional due_date, due_time (HH:MM), duration (HH:MM), note, done, owner_id. The subject gets an '[Agent]' prefix and the note an agent marker. An identical existing activity is reused. Requires requested_by.",
        CreateActivityParamsSchema,
        (params) => client.createActivity(params),
      ),
      tool(
        "update_activity",
        "SOFT CONFIRMATION (owner change is hard: confirmed: true). Update an activity (v2 PATCH): subject, type, due_date, due_time, duration, note, done (use this to complete), owner_id. Pass changes plus expected_before for every changed field. The agent marker is kept once and the change is recorded in the activity note. Requires requested_by.",
        UpdateActivityParamsSchema,
        (params) => client.updateActivity(params),
      ),
      tool(
        "convert_lead_to_deal",
        "HARD CONFIRMATION. Convert a lead into a deal in stage_id (v2 convert; pipeline_id optional). Checks expected_update_time against the lead, blocks if a same-title deal exists for the same person/org, then polls the conversion. Results: converted (trace note 'Lead → Deal' written on the deal), pending (call again with conversion_id to resume; never restarts), failed. Requires requested_by and confirmed: true.",
        ConvertLeadToDealParamsSchema,
        (params) => client.convertLeadToDeal(params),
      ),
      tool(
        "create_lead_label",
        "HARD CONFIRMATION. Create a lead label (name, color green|blue|red|yellow|purple|gray). An existing label with the same name is reused. Label definitions are GLOBAL and cannot own notes, so audit_lead_id (a lead) receives the trace note. Requires requested_by and confirmed: true.",
        CreateLeadLabelParamsSchema,
        (params) => client.createLeadLabel(params),
      ),
      tool(
        "update_lead_label",
        "HARD CONFIRMATION. Rename or recolor a lead label. WARNING: this changes the label on EVERY lead that uses it. Pass changes plus expected_before; audit_lead_id (a lead) receives the trace note. Requires requested_by and confirmed: true.",
        UpdateLeadLabelParamsSchema,
        (params) => client.updateLeadLabel(params),
      ),
    ];
  },
});
