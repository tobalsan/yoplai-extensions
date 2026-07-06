import { z } from "zod";

/**
 * Accepts either a positive-integer number or its string form (config/JSON
 * schema round-trips sometimes deliver numeric params as strings).
 */
const PositiveIntFromInput = z.union([z.number().int().positive(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected positive integer" });
    return z.NEVER;
  }
  return parsed;
});

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

export const PipedriveConfigSchema = z.object({
  apiToken: z
    .string()
    .min(1, "PIPEDRIVE_API_TOKEN is required")
    .describe(
      "Pipedrive API token used to authenticate requests. Find it in Pipedrive under Settings > Personal preferences > API.",
    ),
  domain: z
    .string()
    .min(1, "PIPEDRIVE_DOMAIN is required")
    .describe(
      'Your company\'s Pipedrive subdomain (the part before ".pipedrive.com" in your Pipedrive URL), e.g. "acme" for acme.pipedrive.com.',
    ),
});
export type PipedriveConfig = z.infer<typeof PipedriveConfigSchema>;

export const DealStatusSchema = z.enum([
  "open",
  "won",
  "lost",
  "deleted",
  "all_not_deleted",
]);
export type DealStatus = z.infer<typeof DealStatusSchema>;

export const SortDirectionSchema = z.enum(["asc", "desc"]);

export const ListDealsParamsSchema = z
  .object({
    status: DealStatusSchema.optional().describe(
      'Deal lifecycle filter (server-side). Defaults to "open".',
    ),
    pipeline_id: PositiveIntFromInput.optional().describe("Filter by pipeline ID (server-side)."),
    stage_id: PositiveIntFromInput.optional().describe("Filter by stage ID (server-side)."),
    person_id: PositiveIntFromInput.optional().describe("Filter by linked person ID (server-side)."),
    org_id: PositiveIntFromInput.optional().describe("Filter by linked organization ID (server-side)."),
    user_id: PositiveIntFromInput.optional().describe("Filter by owner user ID (server-side)."),
    expected_close_from: DateOnly.optional().describe(
      "Only include deals whose expected close date is on or after this date (YYYY-MM-DD). Net-new close-date range filter.",
    ),
    expected_close_to: DateOnly.optional().describe(
      "Only include deals whose expected close date is on or before this date (YYYY-MM-DD). Net-new close-date range filter.",
    ),
    won_from: DateOnly.optional().describe(
      "Only include deals won on or after this date (YYYY-MM-DD), compared against won_time. Pair with status: \"won\".",
    ),
    won_to: DateOnly.optional().describe(
      "Only include deals won on or before this date (YYYY-MM-DD), compared against won_time. Pair with status: \"won\".",
    ),
    cursor: z.string().min(1).optional().describe("Opaque cursor from a prior page's next_cursor."),
    limit: PositiveIntFromInput.optional().describe(
      "Max deals per page, 1-500 (default 100). Pagination assembles full pages internally when a close-date range is set.",
    ),
    sort_by: z.string().min(1).optional().describe('Field to sort by (default "update_time").'),
    sort_direction: SortDirectionSchema.optional().describe('Sort direction (default "desc").'),
  })
  .strict();
export type ListDealsParams = z.infer<typeof ListDealsParamsSchema>;

/** Lean per-deal projection returned by list_deals to protect the token budget. */
export const DealSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.string().nullable(),
  stage_id: z.number().nullable(),
  pipeline_id: z.number().nullable(),
  person_id: z.number().nullable(),
  org_id: z.number().nullable(),
  user_id: z.number().nullable(),
  expected_close_date: z.string().nullable(),
  won_time: z.string().nullable(),
  deal_url: z.string().nullable(),
});
export type DealSummary = z.infer<typeof DealSummarySchema>;

export const ListDealsResultSchema = z.object({
  deals: z.array(DealSummarySchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealsResult = z.infer<typeof ListDealsResultSchema>;

/** A deal note with author and timestamps. */
export const NoteSchema = z.object({
  id: z.number(),
  deal_id: z.number().nullable(),
  content: z.string().nullable(),
  user_id: z.number().nullable(),
  user_name: z.string().nullable(),
  person_id: z.number().nullable(),
  org_id: z.number().nullable(),
  add_time: z.string().nullable(),
  update_time: z.string().nullable(),
});
export type Note = z.infer<typeof NoteSchema>;

/** A deal activity (task/call/meeting/email/…) with scheduling and completion. */
export const ActivitySchema = z.object({
  id: z.number(),
  deal_id: z.number().nullable(),
  type: z.string().nullable(),
  subject: z.string().nullable(),
  note: z.string().nullable(),
  done: z.boolean().nullable(),
  due_date: z.string().nullable(),
  due_time: z.string().nullable(),
  marked_as_done_time: z.string().nullable(),
  user_id: z.number().nullable(),
  add_time: z.string().nullable(),
  update_time: z.string().nullable(),
});
export type Activity = z.infer<typeof ActivitySchema>;

const CursorPaginationParams = {
  cursor: z.string().min(1).optional().describe("Opaque cursor from a prior page's next_cursor."),
  limit: PositiveIntFromInput.optional().describe("Max items per page, 1-500 (default 100)."),
};

export const ListDealNotesParamsSchema = z
  .object({
    deal_id: PositiveIntFromInput.describe("ID of the deal whose notes to read."),
    ...CursorPaginationParams,
  })
  .strict();
export type ListDealNotesParams = z.infer<typeof ListDealNotesParamsSchema>;

export const ListDealNotesResultSchema = z.object({
  notes: z.array(NoteSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealNotesResult = z.infer<typeof ListDealNotesResultSchema>;

export const ListDealActivitiesParamsSchema = z
  .object({
    deal_id: PositiveIntFromInput.describe("ID of the deal whose activity history to read."),
    done: z
      .boolean()
      .optional()
      .describe("Filter by completion: true = done only, false = planned only (server-side)."),
    ...CursorPaginationParams,
  })
  .strict();
export type ListDealActivitiesParams = z.infer<typeof ListDealActivitiesParamsSchema>;

export const ListDealActivitiesResultSchema = z.object({
  activities: z.array(ActivitySchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealActivitiesResult = z.infer<typeof ListDealActivitiesResultSchema>;

export const SearchDealsParamsSchema = z
  .object({
    term: z
      .string()
      .min(2, "Search term must be at least 2 characters")
      .describe("Free-text term matched against the deal title (min 2 chars)."),
    status: DealStatusSchema.optional().describe("Filter matches by deal status (server-side)."),
    person_id: PositiveIntFromInput.optional().describe("Filter by linked person ID (server-side)."),
    org_id: PositiveIntFromInput.optional().describe(
      "Filter by linked organization ID (server-side).",
    ),
    exact_match: z
      .boolean()
      .optional()
      .describe("When true, only exact title matches are returned (server-side)."),
    ...CursorPaginationParams,
  })
  .strict();
export type SearchDealsParams = z.infer<typeof SearchDealsParamsSchema>;

/** Lean per-match projection returned by search_deals. */
export const DealSearchMatchSchema = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string().nullable(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  stage_id: z.number().nullable(),
  pipeline_id: z.number().nullable(),
  person_id: z.number().nullable(),
  org_id: z.number().nullable(),
  result_score: z.number().nullable(),
  deal_url: z.string().nullable(),
});
export type DealSearchMatch = z.infer<typeof DealSearchMatchSchema>;

export const SearchDealsResultSchema = z.object({
  deals: z.array(DealSearchMatchSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type SearchDealsResult = z.infer<typeof SearchDealsResultSchema>;

/**
 * A file/attachment linked to a deal. Lean projection over Pipedrive's file
 * record: enough metadata (name, type, size) for Sally to pick the right one,
 * plus the file id needed to download it. Read-only; nothing is parsed.
 */
export const FileSchema = z.object({
  id: z.number().describe("Pipedrive file id — pass to download_file."),
  name: z.string().describe("Human-readable file name (e.g. sale-info.xlsx)."),
  type: z
    .string()
    .nullable()
    .describe("File extension / type reported by Pipedrive (e.g. xlsx, pdf)."),
  size: z
    .number()
    .nullable()
    .describe("File size in bytes, when reported by Pipedrive."),
  deal_id: z.number().nullable().describe("The deal this file is linked to."),
  add_time: z.string().nullable().describe("When the file was uploaded (ISO-ish)."),
  url: z.string().nullable().describe("Pipedrive URL for the file, when present."),
  remote_location: z
    .string()
    .nullable()
    .describe(
      'Remote storage provider when the file lives outside Pipedrive (e.g. "googledocs", "dropbox"). Such files cannot be fetched by download_file — it returns a typed error with the external link. null for natively-stored files, which download normally.',
    ),
});
export type File = z.infer<typeof FileSchema>;

export const ListDealFilesParamsSchema = z
  .object({
    deal_id: PositiveIntFromInput.describe("The deal whose files to list."),
  })
  .strict();
export type ListDealFilesParams = z.infer<typeof ListDealFilesParamsSchema>;

export const ListDealFilesResultSchema = z.object({
  files: z.array(FileSchema),
  count: z.number(),
});
export type ListDealFilesResult = z.infer<typeof ListDealFilesResultSchema>;

export const DownloadFileParamsSchema = z
  .object({
    file_id: PositiveIntFromInput.describe(
      "The Pipedrive file id to download (from list_deal_files).",
    ),
  })
  .strict();
export type DownloadFileParams = z.infer<typeof DownloadFileParamsSchema>;

/**
 * Raw, unparsed download result. Content is returned as base64 so binary
 * formats (e.g. .xlsx) survive JSON transport with byte integrity intact.
 * Downstream (Sally's workflow) decodes and parses — the extension never does.
 */
export const DownloadFileResultSchema = z.object({
  file_id: z.number(),
  name: z.string().nullable(),
  mime_type: z.string().nullable(),
  size: z.number().describe("Exact byte length of the decoded content."),
  encoding: z.literal("base64"),
  content_base64: z.string().describe("Raw file bytes, base64-encoded. Not parsed."),
});
export type DownloadFileResult = z.infer<typeof DownloadFileResultSchema>;

/** Shared cursor-pagination params for the v2 list endpoints below. */
export const CursorPageParamsSchema = z
  .object({
    cursor: z.string().min(1).optional().describe("Opaque cursor from a prior page's next_cursor."),
    limit: PositiveIntFromInput.optional().describe("Max items per page, 1-500 (default 100)."),
  })
  .strict();

// --- Pipelines ---------------------------------------------------------------

export const ListPipelinesParamsSchema = CursorPageParamsSchema;
export type ListPipelinesParams = z.infer<typeof ListPipelinesParamsSchema>;

export const GetPipelineParamsSchema = z
  .object({ pipeline_id: PositiveIntFromInput.describe("Pipeline ID to fetch.") })
  .strict();
export type GetPipelineParams = z.infer<typeof GetPipelineParamsSchema>;

/** Lean pipeline projection (v2 /pipelines). */
export const PipelineSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  order_nr: z.number().nullable(),
  is_selected: z.boolean().nullable(),
  is_deal_probability_enabled: z.boolean().nullable(),
  active: z.boolean().nullable(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const ListPipelinesResultSchema = z.object({
  pipelines: z.array(PipelineSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListPipelinesResult = z.infer<typeof ListPipelinesResultSchema>;

// --- Stages ------------------------------------------------------------------

export const ListStagesParamsSchema = CursorPageParamsSchema.extend({
  pipeline_id: PositiveIntFromInput.optional().describe("Filter stages by pipeline ID (server-side)."),
}).strict();
export type ListStagesParams = z.infer<typeof ListStagesParamsSchema>;

export const GetStageParamsSchema = z
  .object({ stage_id: PositiveIntFromInput.describe("Stage ID to fetch.") })
  .strict();
export type GetStageParams = z.infer<typeof GetStageParamsSchema>;

/** Lean stage projection (v2 /stages). */
export const StageSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  pipeline_id: z.number().nullable(),
  order_nr: z.number().nullable(),
  deal_probability: z.number().nullable(),
  is_deal_rot_enabled: z.boolean().nullable(),
});
export type Stage = z.infer<typeof StageSchema>;

export const ListStagesResultSchema = z.object({
  stages: z.array(StageSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListStagesResult = z.infer<typeof ListStagesResultSchema>;

// --- Deal products / line items ---------------------------------------------

export const ListDealProductsParamsSchema = CursorPageParamsSchema.extend({
  deal_id: PositiveIntFromInput.describe("Deal ID whose attached products (line items) to list."),
}).strict();
export type ListDealProductsParams = z.infer<typeof ListDealProductsParamsSchema>;

/** Lean line-item projection (v2 /deals/{id}/products). */
export const DealProductSchema = z.object({
  id: z.number(),
  product_id: z.number().nullable(),
  name: z.string().nullable(),
  quantity: z.number().nullable(),
  item_price: z.number().nullable(),
  sum: z.number().nullable(),
  currency: z.string().nullable(),
  billing_frequency: z.string().nullable(),
  billing_frequency_cycles: z.number().nullable(),
  tax: z.number().nullable(),
  tax_method: z.string().nullable(),
  discount: z.number().nullable(),
  discount_type: z.string().nullable(),
  product_variation_id: z.number().nullable(),
  comments: z.string().nullable(),
});
export type DealProduct = z.infer<typeof DealProductSchema>;

export const ListDealProductsResultSchema = z.object({
  deal_id: z.number(),
  products: z.array(DealProductSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealProductsResult = z.infer<typeof ListDealProductsResultSchema>;

// --- Deal discounts ----------------------------------------------------------

export const ListDealDiscountsParamsSchema = CursorPageParamsSchema.extend({
  deal_id: PositiveIntFromInput.describe("Deal ID whose deal-level discounts to list."),
}).strict();
export type ListDealDiscountsParams = z.infer<typeof ListDealDiscountsParamsSchema>;

/** Lean deal-level discount projection (v2 /deals/{id}/discounts). */
export const DealDiscountSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  amount: z.number().nullable(),
  type: z.string().nullable(),
});
export type DealDiscount = z.infer<typeof DealDiscountSchema>;

export const ListDealDiscountsResultSchema = z.object({
  deal_id: z.number(),
  discounts: z.array(DealDiscountSchema),
  next_cursor: z.string().nullable(),
  count: z.number(),
});
export type ListDealDiscountsResult = z.infer<typeof ListDealDiscountsResultSchema>;

// ---------------------------------------------------------------------------
// Deal-field schema (custom-field metadata) — Pipedrive API v1 (dealFields)
// ---------------------------------------------------------------------------

/** A selectable option on an enum/set custom field. */
export const DealFieldOptionSchema = z
  .object({
    // Pipedrive option ids are usually numeric but can be strings or even
    // booleans (e.g. yes/no style fields); accept all and stringify downstream.
    id: z.union([z.number(), z.string(), z.boolean()]),
    label: z.coerce.string(),
  })
  .passthrough();
export type DealFieldOption = z.infer<typeof DealFieldOptionSchema>;

/**
 * A Pipedrive dealField definition. `key` is the (often hash-like) column key
 * used on the deal payload; `field_type` drives normalization. Unknown extra
 * properties from the API are captured under `extra_fields`.
 */
export const DealFieldSchema = z.object({
  id: z.number().nullable(),
  key: z.string(),
  name: z.string(),
  field_type: z.string(),
  options: z.array(DealFieldOptionSchema).nullable().optional(),
  edit_flag: z.boolean().optional(),
  add_visible_flag: z.boolean().optional(),
  mandatory_flag: z.boolean().optional(),
  extra_fields: z.record(z.unknown()).optional(),
});
export type DealField = z.infer<typeof DealFieldSchema>;

/** v1 offset-pagination metadata block. */
export const PaginationInfoSchema = z.object({
  start: z.number(),
  limit: z.number(),
  more_items_in_collection: z.boolean(),
  next_start: z.number().nullable().optional(),
});
export type PaginationInfo = z.infer<typeof PaginationInfoSchema>;

export const ListDealFieldsParamsSchema = z
  .object({
    start: z.number().int().nonnegative().optional().describe("Offset for v1 pagination (default 0)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Page size, 1-500 (default 100)."),
  })
  .strict();
export type ListDealFieldsParams = z.infer<typeof ListDealFieldsParamsSchema>;

export const ListDealFieldsResultSchema = z.object({
  fields: z.array(DealFieldSchema),
  pagination: PaginationInfoSchema.nullable(),
});
export type ListDealFieldsResult = z.infer<typeof ListDealFieldsResultSchema>;

export const GetDealFieldParamsSchema = z
  .object({
    field_id: PositiveIntFromInput.describe("Numeric ID of the deal field to retrieve."),
  })
  .strict();
export type GetDealFieldParams = z.infer<typeof GetDealFieldParamsSchema>;

// ---------------------------------------------------------------------------
// FieldRegistry — cached key→field-meta map
// ---------------------------------------------------------------------------

/** Normalization-facing metadata for one custom field. */
export const FieldMetaSchema = z.object({
  name: z.string(),
  type: z.string(),
  /** enum/set option map: string option id → label. Null for non-option types. */
  options: z.record(z.string()).nullable(),
  is_multiple: z.boolean(),
});
export type FieldMeta = z.infer<typeof FieldMetaSchema>;

/** The cached registry: key → FieldMeta, plus provenance for TTL/versioning. */
export const FieldRegistrySchema = z.object({
  version: z.string(),
  built_at: z.string(),
  entity: z.string(),
  by_key: z.record(FieldMetaSchema),
});
export type FieldRegistry = z.infer<typeof FieldRegistrySchema>;

// ---------------------------------------------------------------------------
// get_deal params / result
// ---------------------------------------------------------------------------

export const DealOutputModeSchema = z.enum(["full", "lean"]);
export type DealOutputMode = z.infer<typeof DealOutputModeSchema>;

export const GetDealParamsSchema = z
  .object({
    deal_id: PositiveIntFromInput.describe("Numeric ID of the deal to retrieve."),
    output_type: DealOutputModeSchema.optional().describe(
      'Output mode: "full" (default) returns normalized custom fields + metadata; "lean" strips them.',
    ),
  })
  .strict();
export type GetDealParams = z.infer<typeof GetDealParamsSchema>;

/** Metadata describing one normalized custom field. */
export const NormalizedFieldMetadataSchema = z.object({
  key: z.string(),
  type: z.string(),
});
export type NormalizedFieldMetadata = z.infer<typeof NormalizedFieldMetadataSchema>;

export const DealDetailSchema = z.object({
  id: z.number(),
  title: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.string().nullable(),
  stage_id: z.number().nullable(),
  pipeline_id: z.number().nullable(),
  person_id: z.number().nullable(),
  org_id: z.number().nullable(),
  user_id: z.number().nullable(),
  expected_close_date: z.string().nullable(),
  add_time: z.string().nullable(),
  update_time: z.string().nullable(),
  won_time: z.string().nullable(),
  deal_url: z.string(),
  normalized_extra_fields: z.record(z.unknown()).optional(),
  normalized_field_metadata: z.record(NormalizedFieldMetadataSchema).optional(),
});
export type DealDetail = z.infer<typeof DealDetailSchema>;

export const RefreshFieldRegistryResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  field_count: z.number().optional(),
  version: z.string().optional(),
  built_at: z.string().optional(),
});
export type RefreshFieldRegistryResult = z.infer<typeof RefreshFieldRegistryResultSchema>;

/** Params for the single-entity resolution ops (get_organization / get_person). */
export const EntityByIdParamsSchema = z
  .object({
    id: PositiveIntFromInput.describe(
      "The entity ID to resolve (a deal's org_id for get_organization, or person_id for get_person).",
    ),
  })
  .strict();
export type EntityByIdParams = z.infer<typeof EntityByIdParamsSchema>;

/**
 * Structured postal address as Pipedrive v2 returns it on an organization.
 * All parts are optional; formatted_address is the display-ready line.
 */
export const AddressSchema = z.object({
  formatted_address: z.string().nullable(),
  street_number: z.string().nullable(),
  route: z.string().nullable(),
  locality: z.string().nullable(),
  sublocality: z.string().nullable(),
  admin_area_level_1: z.string().nullable(),
  admin_area_level_2: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
});
export type Address = z.infer<typeof AddressSchema>;

/**
 * Organization entity projection for populating a Pennylane invoice customer:
 * name, address, and VAT/SIREN when they are stored on the org.
 */
export const OrganizationSchema = z.object({
  id: z.number(),
  name: z.string(),
  address: AddressSchema.nullable(),
  vat: z.string().nullable(),
  siren: z.string().nullable(),
  org_url: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

/** A labelled contact detail (email or phone) as Pipedrive stores it. */
export const ContactDetailSchema = z.object({
  label: z.string().nullable(),
  value: z.string(),
  primary: z.boolean(),
});
export type ContactDetail = z.infer<typeof ContactDetailSchema>;

/**
 * Person entity projection: primary contact name plus contact details
 * (emails and phones, primary flagged) needed for the invoice customer.
 */
export const PersonSchema = z.object({
  id: z.number(),
  name: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  job_title: z.string().nullable(),
  org_id: z.number().nullable(),
  emails: z.array(ContactDetailSchema),
  phones: z.array(ContactDetailSchema),
  primary_email: z.string().nullable(),
  primary_phone: z.string().nullable(),
  person_url: z.string(),
});
export type Person = z.infer<typeof PersonSchema>;
