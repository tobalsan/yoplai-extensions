import { z } from "zod";

import { PipedriveClient } from "./client.js";
import {
  DownloadFileParamsSchema,
  EntityByIdParamsSchema,
  GetDealFieldParamsSchema,
  GetDealParamsSchema,
  GetPipelineParamsSchema,
  GetStageParamsSchema,
  ListDealDiscountsParamsSchema,
  ListDealFieldsParamsSchema,
  ListDealFilesParamsSchema,
  ListDealProductsParamsSchema,
  ListDealsParamsSchema,
  ListPipelinesParamsSchema,
  ListStagesParamsSchema,
  PipedriveConfigSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

const RefreshFieldRegistryParamsSchema = z.object({}).strict();

export default defineToolExtension({
  id: "pipedrive",
  displayName: "Pipedrive",
  description:
    "Read-only Pipedrive data access for the sales pipeline: token-bounded deal retrieval with server-side filters and an expected-close-date range narrowing.",
  systemPrompt: `Use this extension to read the Pipedrive sales pipeline (read-only). pipedrive_list_deals returns a lean, token-bounded projection — narrow the pipeline with server-side filters (status, pipeline_id, stage_id, person_id, org_id, user_id) and the expected_close_from / expected_close_to date range (YYYY-MM-DD) rather than pulling every deal. status defaults to "open". To page through a large filtered result, pass the returned next_cursor back as cursor until next_cursor is null; every deal is returned exactly once with no gaps or duplicates.

To resolve a deal's linked entities for an invoice customer: pass the deal's org_id to pipedrive_get_organization (name, address, VAT/SIREN when stored) and its person_id to pipedrive_get_person (contact name + emails/phones). Guard against a deal with no linked org/person: when org_id or person_id is null, do not call these ops — there is nothing to resolve. A missing entity id surfaces as a typed not-found error.

Pipeline & stage metadata: pipedrive_list_pipelines / pipedrive_get_pipeline and pipedrive_list_stages / pipedrive_get_stage (optional pipeline_id filter) resolve stage/pipeline names — use them to detect stages like "Final negotiation" / "Won". Deal line items: pipedrive_list_deal_products returns each product's quantity, unit price (item_price) and billing_frequency (the source for devis amounts and recurring MRR/ARR products). pipedrive_list_deal_discounts returns deal-level discounts. All list ops use the same cursor pagination — page with next_cursor until it is null.

To work with a deal's attachments (e.g. the sales-uploaded Excel/doc that holds the sale info): call pipedrive_list_deal_files with a deal_id to see each file's name, type, and size, pick the right file, then call pipedrive_download_file with its file_id. download_file returns the RAW bytes base64-encoded (content_base64) — the extension never parses or transforms the file. Decode and parse it downstream in your workflow.

pipedrive_get_deal reads one deal in full detail: all standard fields plus custom fields resolved to human-readable labels and typed values (never raw hash keys). output_type "full" (default) includes normalized_extra_fields + normalized_field_metadata; "lean" strips them. Custom-field schema is available via pipedrive_list_deal_fields / pipedrive_get_deal_field (key → label/options/type, v1 offset pagination via start/limit) — use these for invoice mapping and required-field logic. Field metadata is cached locally; pipedrive_refresh_field_registry forces a rebuild if the schema changed.`,
  configSchema: PipedriveConfigSchema,
  requiredSecrets: ["apiToken", "domain"],
  createTools(config) {
    const resolved = PipedriveConfigSchema.parse(config.merged);
    const client = new PipedriveClient(resolved);

    return [
      {
        name: "list_deals",
        description:
          "List deals from the Pipedrive pipeline with a lean per-deal projection. Supports server-side filters (status [default open], pipeline_id, stage_id, person_id, org_id, user_id) and an expected-close-date range (expected_close_from / expected_close_to, YYYY-MM-DD). Returns { deals, next_cursor, count }; pass next_cursor back as cursor to page through the full filtered result.",
        parameters: ListDealsParamsSchema,
        execute: async (params) => {
          const parsed = ListDealsParamsSchema.parse(params);
          return await client.listDeals(parsed);
        },
      },
      {
        name: "list_deal_files",
        description:
          "List the files/attachments on a deal with a lean metadata projection so you can pick the right one. Returns { files, count } where each file has { id, name, type, size (bytes), deal_id, add_time, url }. Returns up to 500 files (deals rarely have more). Read-only; nothing is downloaded or parsed. Pass a file's id to download_file to fetch its bytes.",
        parameters: ListDealFilesParamsSchema,
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
          "Resolve a deal's org_id to the organization entity for an invoice customer: { id, name, address, vat, siren, org_url }. address is structured (formatted_address + parts) or null; vat/siren are null unless stored on the org. Throws a typed not-found error when the organization does not exist.",
        parameters: EntityByIdParamsSchema,
        execute: async (params) => {
          const parsed = EntityByIdParamsSchema.parse(params);
          return await client.getOrganization(parsed.id);
        },
      },
      {
        name: "get_person",
        description:
          "Resolve a deal's person_id to the primary contact entity: { id, name, first_name, last_name, job_title, org_id, emails, phones, primary_email, primary_phone, person_url }. emails/phones are labelled with a primary flag. Throws a typed not-found error when the person does not exist.",
        parameters: EntityByIdParamsSchema,
        execute: async (params) => {
          const parsed = EntityByIdParamsSchema.parse(params);
          return await client.getPerson(parsed.id);
        },
      },
    ];
  },
});
