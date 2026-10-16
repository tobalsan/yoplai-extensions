import { z } from "zod";

import { isRealDate } from "./field-writer.js";

// ---------------------------------------------------------------------------
// Shared building blocks for write tools. Root parameter schemas stay plain
// strict z.object(...); cross-field rules (non-empty patch, expected_before
// coverage, links, activity owner confirmation) are enforced at runtime.
// ---------------------------------------------------------------------------

const RequestedBySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe(
    "Human name of the person who asked for this change, taken from the conversation (ask if unknown). Never use the agent name, the CRM record owner or the shared token owner. Recorded in the visible agent marker / trace note.",
  );

const HardConfirmedSchema = z
  .literal(true)
  .describe(
    "Set true ONLY after the human has seen the exact before→after change and explicitly approved it. Batch approval covers only the listed records and changes.",
  );

const PositiveIdSchema = z.number().int().positive();
const LeadIdSchema = z.string().uuid().describe("Lead UUID.");
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Expected a three-letter ISO currency code, e.g. EUR");

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format")
  .refine(isRealDate, "Not a real calendar date");

/** Live Pipedrive v2 rejects seconds ("due_time: This value is not a valid datetime."), so writes use HH:MM. */
const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a time in HH:MM format");

/** Pipedrive v2 reads times as HH:MM; expected_before also tolerates HH:MM:SS. */
const ExpectedTimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Expected a time in HH:MM or HH:MM:SS format");

const CustomFieldValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
  z.object({ amount: z.number().finite(), currency: CurrencySchema }).strict(),
  z.object({ from: z.string(), until: z.string() }).strict(),
]);

const CustomFieldsSchema = z
  .record(z.string().min(1), CustomFieldValueSchema)
  .describe(
    'Custom fields as { "<exact hash key or unambiguous field name>": value }. enum/set accept option labels or ids; monetary {amount,currency}; ranges {from,until}; null clears. Standard fields are not accepted here.',
  );

const LeadValueSchema = z.object({ amount: z.number().finite(), currency: CurrencySchema }).strict();

const emailEntry = z
  .object({
    value: z.string().email(),
    label: z.string().min(1).max(50).optional(),
    primary: z.boolean().optional(),
  })
  .strict();
const phoneEntry = z
  .object({
    value: z.string().min(3).max(50),
    label: z.string().min(1).max(50).optional(),
    primary: z.boolean().optional(),
  })
  .strict();
const atMostOnePrimary = (entries: { primary?: boolean }[]): boolean =>
  entries.filter((entry) => entry.primary === true).length <= 1;
const EmailsSchema = z
  .array(emailEntry)
  .max(20)
  .refine(atMostOnePrimary, "At most one entry may be primary")
  .describe("COMPLETE replacement list of emails (include entries to keep). Entries: {value, label?, primary?}.");
const PhonesSchema = z
  .array(phoneEntry)
  .max(20)
  .refine(atMostOnePrimary, "At most one entry may be primary")
  .describe("COMPLETE replacement list of phones (include entries to keep). Entries: {value, label?, primary?}.");

const AddressSchema = z
  .object({
    value: z.string().min(1).max(500).describe("Full formatted address line."),
    street_number: z.string().max(100).optional(),
    route: z.string().max(200).optional(),
    sublocality: z.string().max(200).optional(),
    locality: z.string().max(200).optional(),
    admin_area_level_1: z.string().max(200).optional(),
    admin_area_level_2: z.string().max(200).optional(),
    country: z.string().max(100).optional(),
    postal_code: z.string().max(50).optional(),
  })
  .strict();

const nullableText = z.string().max(500).nullable().optional();
/** The address exactly as get_organization returns it (formatted_address, nullable parts) or as written (value). */
const ExpectedAddressSchema = z
  .object({
    value: nullableText,
    formatted_address: nullableText,
    street_number: nullableText,
    route: nullableText,
    sublocality: nullableText,
    locality: nullableText,
    admin_area_level_1: nullableText,
    admin_area_level_2: nullableText,
    country: nullableText,
    postal_code: nullableText,
  })
  .strict();

/** Contact entries exactly as get_person returns them (label may be null). */
const ExpectedContactEntrySchema = z
  .object({ value: z.string(), label: z.string().nullable().optional(), primary: z.boolean().optional() })
  .strict();
const ExpectedContactListSchema = z.array(ExpectedContactEntrySchema).max(20);

/**
 * expected_before mirrors a changes shape: every changed field with its current
 * value (null when empty). `readShapes` replaces the write schema of fields whose
 * read output differs from what is written (nulls, formatted_address, HH:MM).
 */
function expectedBeforeOf<S extends z.ZodRawShape, R extends { [K in keyof S]?: z.ZodTypeAny } = Record<never, never>>(shape: S, readShapes?: R) {
  const entries = Object.entries(shape).map(
    ([key, schema]) => [key, ((readShapes as Record<string, z.ZodTypeAny> | undefined)?.[key] ?? schema).nullable().optional()] as const,
  );
  type Expected = { [K in keyof S]: z.ZodOptional<z.ZodNullable<K extends keyof R ? (R[K] extends z.ZodTypeAny ? R[K] : S[K]) : S[K]>> };
  return z
    .object(Object.fromEntries(entries) as Expected)
    .strict()
    .describe(
      "Current value of EVERY field in changes (null when empty), as just read from the record. A mismatch aborts the write with a conflict result.",
    );
}

function changesOf<S extends z.ZodRawShape>(shape: S) {
  return z
    .object(shape)
    .partial()
    .strict()
    .describe("Fields to change. Omitted fields stay unchanged; null clears only where allowed. List fields are full replacements.");
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const leadChangeShape = {
  title: z.string().trim().min(1).max(255),
  value: LeadValueSchema,
  expected_close_date: DateOnlySchema.nullable(),
  owner_id: PositiveIdSchema,
  label_ids: z.array(LeadIdSchema).max(20),
  person_id: PositiveIdSchema.nullable(),
  organization_id: PositiveIdSchema.nullable(),
  is_archived: z.boolean().describe("true archives the lead; false unarchives. Leads are never deleted."),
  custom_fields: CustomFieldsSchema,
};
const leadChanges = changesOf(leadChangeShape);
export type LeadChanges = z.infer<typeof leadChanges>;

export const CreateLeadParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    title: leadChangeShape.title,
    person_id: PositiveIdSchema.optional().describe("Linked person. At least one of person_id / organization_id is required."),
    organization_id: PositiveIdSchema.optional().describe("Linked organization. At least one of person_id / organization_id is required."),
    owner_id: PositiveIdSchema.optional(),
    label_ids: leadChangeShape.label_ids.optional(),
    value: LeadValueSchema.optional(),
    expected_close_date: DateOnlySchema.optional(),
    custom_fields: CustomFieldsSchema.optional(),
  })
  .strict();
export type CreateLeadParams = z.infer<typeof CreateLeadParamsSchema>;

export const UpdateLeadParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    id: LeadIdSchema,
    changes: leadChanges,
    expected_before: expectedBeforeOf(leadChangeShape),
  })
  .strict();
export type UpdateLeadParams = z.infer<typeof UpdateLeadParamsSchema>;

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

const dealChangeShape = {
  title: z.string().trim().min(1).max(255),
  value: z.number().finite(),
  currency: CurrencySchema,
  stage_id: PositiveIdSchema,
  pipeline_id: PositiveIdSchema.describe("Changing the pipeline also requires stage_id (a stage of that pipeline)."),
  expected_close_date: DateOnlySchema.nullable(),
  status: z.enum(["open", "won", "lost"]).describe("Deals are never deleted through this extension."),
  lost_reason: z.string().trim().min(1).max(255).describe("Only together with status lost."),
  owner_id: PositiveIdSchema,
  person_id: PositiveIdSchema,
  org_id: PositiveIdSchema,
  custom_fields: CustomFieldsSchema,
};
const dealChanges = changesOf(dealChangeShape);
export type DealChanges = z.infer<typeof dealChanges>;

export const CreateDealParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    title: dealChangeShape.title,
    person_id: PositiveIdSchema.optional(),
    org_id: PositiveIdSchema.optional(),
    owner_id: PositiveIdSchema.optional(),
    stage_id: PositiveIdSchema.optional(),
    pipeline_id: PositiveIdSchema.optional(),
    value: dealChangeShape.value.optional(),
    currency: CurrencySchema.optional(),
    expected_close_date: DateOnlySchema.optional(),
    custom_fields: CustomFieldsSchema.optional(),
  })
  .strict();
export type CreateDealParams = z.infer<typeof CreateDealParamsSchema>;

export const UpdateDealParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    deal_id: PositiveIdSchema,
    changes: dealChanges,
    expected_before: expectedBeforeOf(dealChangeShape),
  })
  .strict();
export type UpdateDealParams = z.infer<typeof UpdateDealParamsSchema>;

// ---------------------------------------------------------------------------
// Persons and organizations
// ---------------------------------------------------------------------------

const personChangeShape = {
  name: z.string().trim().min(1).max(255),
  org_id: PositiveIdSchema.nullable(),
  owner_id: PositiveIdSchema,
  emails: EmailsSchema,
  phones: PhonesSchema,
  custom_fields: CustomFieldsSchema,
};
const personChanges = changesOf(personChangeShape);
export type PersonChanges = z.infer<typeof personChanges>;

export const CreatePersonParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    name: personChangeShape.name,
    org_id: PositiveIdSchema.optional(),
    owner_id: PositiveIdSchema.optional(),
    emails: EmailsSchema.optional(),
    phones: PhonesSchema.optional(),
    custom_fields: CustomFieldsSchema.optional(),
  })
  .strict();
export type CreatePersonParams = z.infer<typeof CreatePersonParamsSchema>;

export const UpdatePersonParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    id: PositiveIdSchema,
    changes: personChanges,
    expected_before: expectedBeforeOf(personChangeShape, { emails: ExpectedContactListSchema, phones: ExpectedContactListSchema }),
  })
  .strict();
export type UpdatePersonParams = z.infer<typeof UpdatePersonParamsSchema>;

const organizationChangeShape = {
  name: z.string().trim().min(1).max(255),
  owner_id: PositiveIdSchema,
  address: AddressSchema.describe("Replacement address; every omitted component is cleared. Compared by the formatted `value` line and all components."),
  custom_fields: CustomFieldsSchema.describe(
    "Custom fields incl. VAT / SIREN, which are organization custom fields (look them up with list_contact_fields).",
  ),
};
const organizationChanges = changesOf(organizationChangeShape);
export type OrganizationChanges = z.infer<typeof organizationChanges>;

export const CreateOrganizationParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    name: organizationChangeShape.name,
    owner_id: PositiveIdSchema.optional(),
    address: AddressSchema.optional(),
    custom_fields: organizationChangeShape.custom_fields.optional(),
  })
  .strict();
export type CreateOrganizationParams = z.infer<typeof CreateOrganizationParamsSchema>;

export const UpdateOrganizationParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    id: PositiveIdSchema,
    changes: organizationChanges,
    expected_before: expectedBeforeOf(organizationChangeShape, { address: ExpectedAddressSchema }),
  })
  .strict();
export type UpdateOrganizationParams = z.infer<typeof UpdateOrganizationParamsSchema>;

// ---------------------------------------------------------------------------
// Notes and activities (soft confirmation)
// ---------------------------------------------------------------------------

export const CreateNoteParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    lead_id: LeadIdSchema.optional(),
    deal_id: PositiveIdSchema.optional(),
    person_id: PositiveIdSchema.optional(),
    org_id: PositiveIdSchema.optional(),
    content: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe("Plain text (stored HTML-escaped). The agent marker is added by the tool; do not add one."),
  })
  .strict();
export type CreateNoteParams = z.infer<typeof CreateNoteParamsSchema>;

const SoftOwnerConfirmationSchema = z
  .literal(true)
  .optional()
  .describe("Required (true, after explicit human approval) only when assigning or changing the activity owner; not needed otherwise.");

const activityChangeShape = {
  subject: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(100).describe("Activity type key_string (see list_activity_types)."),
  due_date: DateOnlySchema,
  due_time: TimeOfDaySchema,
  duration: TimeOfDaySchema.describe("Duration as HH:MM."),
  note: z.string().trim().min(1).max(20_000).describe("Plain text note body (stored HTML-escaped)."),
  done: z.boolean(),
  owner_id: PositiveIdSchema.describe("Changing the owner needs confirmed: true."),
};
const activityChanges = changesOf(activityChangeShape);
export type ActivityChanges = z.infer<typeof activityChanges>;

export const CreateActivityParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: SoftOwnerConfirmationSchema,
    subject: activityChangeShape.subject,
    type: activityChangeShape.type,
    lead_id: LeadIdSchema.optional(),
    deal_id: PositiveIdSchema.optional(),
    person_id: PositiveIdSchema.optional(),
    org_id: PositiveIdSchema.optional(),
    due_date: activityChangeShape.due_date.optional(),
    due_time: activityChangeShape.due_time.optional(),
    duration: activityChangeShape.duration.optional(),
    note: activityChangeShape.note.optional(),
    done: z.boolean().optional(),
    owner_id: activityChangeShape.owner_id.optional(),
  })
  .strict();
export type CreateActivityParams = z.infer<typeof CreateActivityParamsSchema>;

export const UpdateActivityParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: SoftOwnerConfirmationSchema,
    id: PositiveIdSchema,
    changes: activityChanges,
    expected_before: expectedBeforeOf(activityChangeShape, { due_time: ExpectedTimeOfDaySchema, duration: ExpectedTimeOfDaySchema }),
  })
  .strict();
export type UpdateActivityParams = z.infer<typeof UpdateActivityParamsSchema>;

// ---------------------------------------------------------------------------
// Conversion and lead labels
// ---------------------------------------------------------------------------

export const ConvertLeadToDealParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    lead_id: LeadIdSchema,
    stage_id: PositiveIdSchema.describe("Destination stage of the new deal."),
    pipeline_id: PositiveIdSchema.optional().describe("Optional; when given it must own stage_id."),
    expected_update_time: z
      .string()
      .min(1)
      .describe("The lead's update_time as just read (get_lead). A mismatch aborts the conversion with a conflict result."),
    conversion_id: z
      .string()
      .min(1)
      .optional()
      .describe("Pass the conversion_id from a pending result to resume status checks. This never re-sends the conversion."),
  })
  .strict();
export type ConvertLeadToDealParams = z.infer<typeof ConvertLeadToDealParamsSchema>;

export const LeadLabelColorSchema = z.enum(["green", "blue", "red", "yellow", "purple", "gray"]);

const AuditLeadIdSchema = LeadIdSchema.describe(
  "A lead that receives the trace note, because label definitions cannot own notes. Renaming or recoloring a label changes it on EVERY lead that uses it.",
);

const labelChangeShape = {
  name: z.string().trim().min(1).max(50),
  color: LeadLabelColorSchema,
};
const labelChanges = changesOf(labelChangeShape);
export type LeadLabelChanges = z.infer<typeof labelChanges>;

export const CreateLeadLabelParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    name: labelChangeShape.name,
    color: LeadLabelColorSchema.optional().describe("Defaults to gray."),
    audit_lead_id: AuditLeadIdSchema,
  })
  .strict();
export type CreateLeadLabelParams = z.infer<typeof CreateLeadLabelParamsSchema>;

export const UpdateLeadLabelParamsSchema = z
  .object({
    requested_by: RequestedBySchema,
    confirmed: HardConfirmedSchema,
    id: z.string().uuid().describe("Lead label UUID."),
    changes: labelChanges,
    expected_before: expectedBeforeOf(labelChangeShape),
    audit_lead_id: AuditLeadIdSchema,
  })
  .strict();
export type UpdateLeadLabelParams = z.infer<typeof UpdateLeadLabelParamsSchema>;

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

export const NoteTargetSchema = z.union([
  z.object({ lead_id: z.string() }).strict(),
  z.object({ deal_id: z.number() }).strict(),
  z.object({ person_id: z.number() }).strict(),
  z.object({ org_id: z.number() }).strict(),
]);
export type NoteTarget = z.infer<typeof NoteTargetSchema>;

export const WriteEntitySchema = z.enum(["lead", "deal", "person", "organization", "note", "activity", "lead_label"]);
export type WriteEntity = z.infer<typeof WriteEntitySchema>;

const RecordIdSchema = z.union([z.string(), z.number()]);

export const DiffEntrySchema = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const TraceStatusSchema = z.enum(["created", "failed", "unknown", "not_required"]);
export type TraceStatus = z.infer<typeof TraceStatusSchema>;

export const TraceRepairSchema = z.object({
  target: NoteTargetSchema,
  content: z.string(),
  instruction: z.string(),
});
export type TraceRepair = z.infer<typeof TraceRepairSchema>;

export const AppliedOutcomeSchema = z.object({
  status: z.literal("applied"),
  applied: z.literal(true),
  entity: WriteEntitySchema,
  id: RecordIdSchema,
  url: z.string().nullable(),
  changes: z.array(DiffEntrySchema),
  trace_status: TraceStatusSchema,
  trace_note_id: z.number().nullable(),
  trace_repair: TraceRepairSchema.nullable(),
  partial_success: z.boolean(),
  message: z.string(),
});
export type AppliedOutcome = z.infer<typeof AppliedOutcomeSchema>;

export const UnchangedOutcomeSchema = z.object({
  status: z.literal("unchanged"),
  entity: WriteEntitySchema,
  id: RecordIdSchema,
  message: z.string(),
});
export type UnchangedOutcome = z.infer<typeof UnchangedOutcomeSchema>;

export const ReusedOutcomeSchema = z.object({
  status: z.literal("reused"),
  entity: WriteEntitySchema,
  id: RecordIdSchema,
  message: z.string(),
});
export type ReusedOutcome = z.infer<typeof ReusedOutcomeSchema>;

export const ConflictOutcomeSchema = z.object({
  status: z.literal("conflict"),
  entity: WriteEntitySchema,
  id: RecordIdSchema,
  conflicts: z.array(z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown() })),
  message: z.string(),
});
export type ConflictOutcome = z.infer<typeof ConflictOutcomeSchema>;

export const DuplicateCandidatesOutcomeSchema = z.object({
  status: z.literal("duplicate_candidates"),
  entity: WriteEntitySchema,
  candidates: z.array(z.object({ id: RecordIdSchema, summary: z.string(), matched_on: z.array(z.string()) })),
  message: z.string(),
});
export type DuplicateCandidatesOutcome = z.infer<typeof DuplicateCandidatesOutcomeSchema>;

export const ConversionOutcomeSchema = z.object({
  status: z.enum(["converted", "pending", "failed"]),
  lead_id: z.string(),
  conversion_id: z.string(),
  deal_id: z.number().nullable(),
  conversion_status: z.string(),
  trace_status: TraceStatusSchema,
  trace_repair: TraceRepairSchema.nullable(),
  partial_success: z.boolean(),
  message: z.string(),
});
export type ConversionOutcome = z.infer<typeof ConversionOutcomeSchema>;

export const WriteOutcomeSchema = z.union([
  AppliedOutcomeSchema,
  UnchangedOutcomeSchema,
  ReusedOutcomeSchema,
  ConflictOutcomeSchema,
  DuplicateCandidatesOutcomeSchema,
  ConversionOutcomeSchema,
]);
export type WriteOutcome = z.infer<typeof WriteOutcomeSchema>;
