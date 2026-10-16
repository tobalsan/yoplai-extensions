import { PipedriveClient, flattenLeadCustomFields, type PipedriveClientOptions } from "./client.js";
import {
  PipedriveAuthError,
  PipedriveError,
  PipedriveNotFoundError,
  PipedriveOutcomeUnknownError,
  PipedriveValidationError,
} from "./errors.js";
import {
  type CanonicalValue,
  type FieldIndex,
  type FieldApiVersion,
  type ResolvedCustomField,
  buildFieldIndex,
  canonicalEquals,
  canonicalFromRaw,
  encodeCustomFields,
  normalizeTime,
  readableValue,
  resolveField,
  toCanonical,
} from "./field-writer.js";
import {
  type ConversionOutcome,
  type ConvertLeadToDealParams,
  type CreateActivityParams,
  type CreateLeadLabelParams,
  type CreateLeadParams,
  type CreateDealParams,
  type CreateNoteParams,
  type CreateOrganizationParams,
  type CreatePersonParams,
  type DiffEntry,
  type NoteTarget,
  type TraceRepair,
  type TraceStatus,
  type UpdateActivityParams,
  type UpdateDealParams,
  type UpdateLeadLabelParams,
  type UpdateLeadParams,
  type UpdateOrganizationParams,
  type UpdatePersonParams,
  type WriteEntity,
  type WriteOutcome,
} from "./write-models.js";
import {
  ACTIVITY_SUBJECT_PREFIX,
  escapedParagraph,
  expectedNoteBody,
  formatValue,
  renderActivityNote,
  renderNote,
  renderTrace,
  storedNoteBody,
  stripAgentMarkers,
} from "./write-format.js";

const DUPLICATE_CHECK_PAGE_SIZE = 100;
/** Safety bound on pages scanned by a duplicate check; hitting it blocks creation rather than assuming "no matches". */
const MAX_CHECK_PAGES = 20;

export interface PipedriveWriteClientOptions extends PipedriveClientOptions {
  /** Status polls after starting a lead conversion before returning `pending` (default 5). */
  conversionPollAttempts?: number;
  /** Delay between conversion status polls in ms (default 1000). */
  conversionPollDelayMs?: number;
}

type FieldEntity = "deal" | "person" | "organization";
type Json = Record<string, unknown>;

interface EntitySpec {
  entity: "lead" | "deal" | "person" | "organization";
  version: FieldApiVersion;
  fieldEntity: FieldEntity;
  recordPath(id: string | number): string;
  traceTarget(id: string | number): NoteTarget;
  /** Standard-field values of a raw record, shaped like the tool's `changes` input. */
  currentStandard(raw: Json): Json;
  rawCustom(raw: Json): Json;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function refId(value: unknown): number | null {
  return isRecord(value) && typeof value.id === "number" ? value.id : null;
}

function validation(message: string): PipedriveValidationError {
  return new PipedriveValidationError(message);
}

function incompleteCheck(what: string): PipedriveError {
  return new PipedriveError(`${what} could not be completed (search failed, malformed or truncated), so creation is blocked rather than assuming there are no duplicates. Retry later or narrow the data.`);
}

/** Fields (and their JS types) a scanned row must carry for its endpoint; a row without them fails the whole check. */
type RowShape = Record<string, "string" | "number">;
/** A row that passed its RowShape check: the required fields carry their declared types. */
type ScannedRow<S extends RowShape> = Json & { [K in keyof S]: S[K] extends "number" ? number : string };
const LEAD_ROW = { id: "string", title: "string" } satisfies RowShape;
const DEAL_ROW = { id: "number", title: "string" } satisfies RowShape;
const PERSON_ROW = { id: "number", name: "string" } satisfies RowShape;
const ORGANIZATION_ROW = { id: "number", name: "string" } satisfies RowShape;
const ACTIVITY_ROW = { id: "number", subject: "string", type: "string" } satisfies RowShape;
const NOTE_ROW = { id: "number", content: "string" } satisfies RowShape;

function matchesRowShape<S extends RowShape>(item: Json, shape: S): item is ScannedRow<S> {
  return Object.entries(shape).every(([field, type]) => typeof item[field] === type);
}

/** Subject without the agent prefix, for comparing an agent-made activity with a human-made one. */
function bareSubject(subject: string): string {
  return normalizeName(subject.startsWith(ACTIVITY_SUBJECT_PREFIX) ? subject.slice(ACTIVITY_SUBJECT_PREFIX.length) : subject);
}

function fieldLabel(key: string): string {
  const words = key.replace(/_id$/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ADDRESS_COMPONENTS = ["street_number", "route", "sublocality", "locality", "admin_area_level_1", "admin_area_level_2", "country", "postal_code"] as const;

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Address line plus the components that are set, so a component-only change shows in diffs and traces. */
function formatAddress(address: Json): string {
  const line = textOrNull(address.value ?? address.formatted_address);
  const parts = ADDRESS_COMPONENTS.flatMap((part) => {
    const text = textOrNull(address[part]);
    return text === null ? [] : [`${part} ${text}`];
  });
  if (line === null) return parts.length === 0 ? "empty" : parts.join(", ");
  return parts.length === 0 ? line : `${line} (${parts.join(", ")})`;
}

/** Comparable form of a standard-field value: equal canon means "no change". */
function canonStandard(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    return key === "due_time" || key === "duration" ? (normalizeTime(trimmed) ?? trimmed) : trimmed;
  }
  if (key === "label_ids" && Array.isArray(value)) return [...new Set(value.map(String))].sort();
  if ((key === "emails" || key === "phones") && Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((entry) => ({ value: String(entry.value ?? "").trim(), label: typeof entry.label === "string" ? entry.label : null, primary: entry.primary === true }))
      .sort((a, b) => a.value.localeCompare(b.value));
  }
  if (key === "address" && isRecord(value)) {
    const canonical = { value: textOrNull(value.value ?? value.formatted_address), ...Object.fromEntries(ADDRESS_COMPONENTS.map((part) => [part, textOrNull(value[part])])) };
    return Object.values(canonical).every((part) => part === null) ? null : canonical;
  }
  if (key === "value" && isRecord(value)) return { amount: Number(value.amount), currency: value.currency };
  return value;
}

function sameStandard(key: string, a: unknown, b: unknown): boolean {
  if (key === "note") return sameNote(a, b);
  return JSON.stringify(canonStandard(key, a)) === JSON.stringify(canonStandard(key, b));
}

/** Two stored activity notes (e.g. expected_before vs current): equal as stored HTML, ignoring agent markers, wrapper and whitespace. */
function sameNote(a: unknown, b: unknown): boolean {
  const left = typeof a === "string" ? stripAgentMarkers(a) : "";
  const right = typeof b === "string" ? stripAgentMarkers(b) : "";
  return left === right || storedNoteBody(left) === storedNoteBody(right);
}

/** Stored activity note HTML versus requested plaintext: the text is encoded and normalised as Pipedrive will store it. */
function noteMatchesText(storedHtml: unknown, text: unknown): boolean {
  return typeof storedHtml === "string" && typeof text === "string" && storedNoteBody(stripAgentMarkers(storedHtml)) === expectedNoteBody(text);
}

const LEAD_SPEC: EntitySpec = {
  entity: "lead",
  version: "v1",
  fieldEntity: "deal",
  recordPath: (id) => `leads/${id}`,
  traceTarget: (id) => ({ lead_id: String(id) }),
  currentStandard: (raw) => ({
    title: raw.title,
    value: isRecord(raw.value) && typeof raw.value.amount === "number" ? { amount: raw.value.amount, currency: raw.value.currency } : null,
    expected_close_date: raw.expected_close_date,
    owner_id: raw.owner_id,
    label_ids: raw.label_ids,
    person_id: raw.person_id,
    organization_id: raw.organization_id,
    is_archived: raw.is_archived === true,
  }),
  rawCustom: (raw) => flattenLeadCustomFields(raw as Parameters<typeof flattenLeadCustomFields>[0]),
};

const DEAL_SPEC: EntitySpec = {
  entity: "deal",
  version: "v2",
  fieldEntity: "deal",
  recordPath: (id) => `deals/${id}`,
  traceTarget: (id) => ({ deal_id: Number(id) }),
  currentStandard: (raw) => ({
    title: raw.title,
    value: raw.value,
    currency: raw.currency,
    stage_id: raw.stage_id,
    pipeline_id: raw.pipeline_id,
    expected_close_date: raw.expected_close_date,
    status: raw.status,
    lost_reason: raw.lost_reason,
    owner_id: raw.owner_id ?? raw.user_id,
    person_id: raw.person_id,
    org_id: raw.org_id,
  }),
  rawCustom: (raw) => (isRecord(raw.custom_fields) ? raw.custom_fields : {}),
};

const PERSON_SPEC: EntitySpec = {
  entity: "person",
  version: "v2",
  fieldEntity: "person",
  recordPath: (id) => `persons/${id}`,
  traceTarget: (id) => ({ person_id: Number(id) }),
  currentStandard: (raw) => ({ name: raw.name, org_id: raw.org_id, owner_id: raw.owner_id, emails: raw.emails, phones: raw.phones }),
  rawCustom: (raw) => (isRecord(raw.custom_fields) ? raw.custom_fields : {}),
};

const ORGANIZATION_SPEC: EntitySpec = {
  entity: "organization",
  version: "v2",
  fieldEntity: "organization",
  recordPath: (id) => `organizations/${id}`,
  traceTarget: (id) => ({ org_id: Number(id) }),
  currentStandard: (raw) => ({ name: raw.name, owner_id: raw.owner_id, address: raw.address }),
  rawCustom: (raw) => (isRecord(raw.custom_fields) ? raw.custom_fields : {}),
};

interface PreparedCustomChanges {
  /** Hash key → canonical requested value. */
  requested: Map<string, ResolvedCustomField>;
  expected: Map<string, ResolvedCustomField>;
}

interface UpdatePlan {
  spec: EntitySpec;
  id: string | number;
  requestedBy: string;
  changes: Json;
  expectedBefore: Json;
  /** Extra cross-field checks run with the merged post-change view, before any write. */
  validateAfter?: (current: Json, effective: Json) => Promise<void>;
}

/**
 * Pipedrive client with confirmed write operations. Every public mutation
 * asserts allowWrite before any network I/O, reads the current record first,
 * guards against stale edits, enforces search-before-create and records a
 * trace note. Mutations are never replayed after an unknown outcome.
 */
export class PipedriveWriteClient extends PipedriveClient {
  private readonly conversionPollAttempts: number;
  private readonly conversionPollDelayMs: number;

  constructor(options: PipedriveWriteClientOptions) {
    super(options);
    this.conversionPollAttempts = options.conversionPollAttempts ?? 5;
    this.conversionPollDelayMs = options.conversionPollDelayMs ?? 1000;
  }

  private assertWritable(): void {
    if (!this.allowWrite) {
      throw new PipedriveAuthError("Pipedrive write tools are disabled: allowWrite is not enabled for this agent.");
    }
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private async mutate(method: "POST" | "PATCH", version: FieldApiVersion, endpoint: string, body: Json): Promise<Json> {
    return this.requestJson(method, version, endpoint, {}, body);
  }

  /** The created/updated record from a mutation envelope; a missing id means the outcome cannot be confirmed. */
  private mutationRecord(envelope: Json, endpoint: string): Json {
    const record = envelope.data;
    if (!isRecord(record) || (typeof record.id !== "number" && typeof record.id !== "string")) {
      throw new PipedriveOutcomeUnknownError(
        `Pipedrive accepted the request to ${endpoint} but returned no record id; the change may have been applied. Read the record to reconcile before any retry.`,
        { endpoint },
      );
    }
    return record;
  }

  private async readRecord(spec: EntitySpec, id: string | number): Promise<Json> {
    const endpoint = spec.recordPath(id);
    const data = await this.requestJson("GET", spec.version, endpoint);
    if (!isRecord(data.data) || (typeof data.data.id !== "number" && typeof data.data.id !== "string")) {
      throw new PipedriveNotFoundError(`${spec.entity} ${id} not found`, { endpoint, status: 404 });
    }
    return data.data;
  }

  private recordUrl(entity: WriteEntity, id: string | number): string | null {
    const base = `https://${this.domain}.pipedrive.com`;
    if (entity === "lead") return `${base}/leads/inbox/${id}`;
    if (entity === "deal") return `${base}/deal/${id}`;
    if (entity === "person") return `${base}/person/${id}`;
    if (entity === "organization") return `${base}/organization/${id}`;
    return null;
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private async assertActiveOwner(ownerId: number): Promise<void> {
    const { users } = await this.listUsers();
    const user = users.find((candidate) => candidate.id === ownerId);
    if (!user) throw validation(`owner_id ${ownerId} is not a Pipedrive user. Use list_users to find a valid id.`);
    if (!user.active) throw validation(`owner_id ${ownerId} (${user.name}) is deactivated.`);
  }

  private async assertStageInPipeline(stageId: number, pipelineId: number | null): Promise<void> {
    const stage = await this.getStage(stageId);
    if (pipelineId !== null && stage.pipeline_id !== pipelineId) {
      throw validation(`stage_id ${stageId} belongs to pipeline ${String(stage.pipeline_id)}, not pipeline ${pipelineId}.`);
    }
  }

  private async loadFieldIndex(entity: FieldEntity): Promise<FieldIndex> {
    return buildFieldIndex(await this.fetchAllFields(entity));
  }

  /** Resolve a `custom_fields` input map to keyed canonical values (rejects unknown/ambiguous fields and bad values). */
  private resolveCustomInput(index: FieldIndex, input: Json | undefined, version: FieldApiVersion): Map<string, ResolvedCustomField> {
    const resolved = new Map<string, ResolvedCustomField>();
    for (const [reference, value] of Object.entries(input ?? {})) {
      const field = resolveField(index, reference);
      if (resolved.has(field.key)) throw validation(`custom field "${field.name}" was given more than once (by name and key).`);
      resolved.set(field.key, { field, canonical: toCanonical(field, value, version) });
    }
    return resolved;
  }

  private async resolveCustomForCreate(entity: FieldEntity, input: Json | undefined, version: FieldApiVersion): Promise<ResolvedCustomField[]> {
    if (!input || Object.keys(input).length === 0) return [];
    const index = await this.loadFieldIndex(entity);
    return [...this.resolveCustomInput(index, input, version).values()];
  }

  // -------------------------------------------------------------------------
  // Notes and traces
  // -------------------------------------------------------------------------

  private async postNote(target: NoteTarget, html: string): Promise<number> {
    const envelope = await this.mutate("POST", "v1", "notes", { content: html, ...target });
    const record = this.mutationRecord(envelope, "notes");
    return Number(record.id);
  }

  /** Every note on a target, or throws when the scan is incomplete. */
  private async listAllNotes(target: NoteTarget): Promise<{ id: number; content: string }[]> {
    const rows = await this.scan("Note duplicate check", "v1", "notes", { ...target, sort: "add_time DESC" }, "list", NOTE_ROW);
    return rows.map((row) => ({ id: row.id, content: row.content }));
  }

  private async recordTrace(target: NoteTarget, text: string): Promise<{ status: TraceStatus; noteId: number | null; repair: TraceRepair | null }> {
    try {
      return { status: "created", noteId: await this.postNote(target, renderTrace(text)), repair: null };
    } catch (error) {
      return { status: error instanceof PipedriveOutcomeUnknownError ? "unknown" : "failed", noteId: null, repair: this.traceRepair(target, text) };
    }
  }

  private traceRepair(target: NoteTarget, text: string): TraceRepair {
    return {
      target,
      content: text,
      instruction:
        "The change itself was applied. Repair the audit trail by calling create_note on this target with this exact content and the same requested_by (it is deduplicated, so it is safe if the trace actually landed). Do NOT repeat the original change.",
    };
  }

  private traceTimestamp(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private appliedOutcome(entity: WriteEntity, id: string | number, changes: DiffEntry[], trace: { status: TraceStatus; noteId: number | null; repair: TraceRepair | null }, verb: string): WriteOutcome {
    const partial = trace.status === "failed" || trace.status === "unknown";
    return {
      status: "applied",
      applied: true,
      entity,
      id,
      url: this.recordUrl(entity, id),
      changes,
      trace_status: trace.status,
      trace_note_id: trace.noteId,
      trace_repair: trace.repair,
      partial_success: partial,
      message: partial
        ? `${verb} ${entity} ${id}, but the trace note is missing (trace_status: ${trace.status}). Do not report this as fully audited; repair it with create_note using trace_repair. Do not repeat the change.`
        : `${verb} ${entity} ${id}.`,
    };
  }

  // -------------------------------------------------------------------------
  // Generic update flow (leads, deals, persons, organizations)
  // -------------------------------------------------------------------------

  private async displayValue(key: string, value: unknown, owners: Map<number, string>, labels: Map<string, string>): Promise<string> {
    if (key === "owner_id" && typeof value === "number") return owners.get(value) ?? `user #${value}`;
    if (key === "label_ids" && Array.isArray(value)) return value.length === 0 ? "empty" : value.map((id) => labels.get(String(id)) ?? String(id)).join(", ");
    if ((key === "emails" || key === "phones") && Array.isArray(value)) {
      return value.length === 0 ? "empty" : value.filter(isRecord).map((entry) => `${String(entry.value)}${entry.primary === true ? " (primary)" : ""}`).join(", ");
    }
    if (key === "address" && isRecord(value)) return formatAddress(value);
    return formatValue(value);
  }

  private async updateRecord(plan: UpdatePlan): Promise<WriteOutcome> {
    const { spec, id, requestedBy } = plan;
    const { custom_fields: customInput, ...standardChanges } = plan.changes;
    const { custom_fields: expectedCustomInput, ...standardExpected } = plan.expectedBefore;
    const standardKeys = Object.keys(standardChanges).filter((key) => standardChanges[key] !== undefined);
    const customChangeInput = isRecord(customInput) ? customInput : {};
    const customExpectedInput = isRecord(expectedCustomInput) ? expectedCustomInput : {};

    // 1. Shape validation before any I/O: non-empty patch and exact expected_before coverage.
    if (standardKeys.length === 0 && Object.keys(customChangeInput).length === 0) {
      throw validation("changes is empty: provide at least one field to change.");
    }
    const expectedKeys = Object.keys(standardExpected).filter((key) => standardExpected[key] !== undefined);
    const missing = standardKeys.filter((key) => standardExpected[key] === undefined);
    const extra = expectedKeys.filter((key) => !standardKeys.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      throw validation(
        `expected_before must contain exactly the changed fields. Missing: ${missing.join(", ") || "none"}. Unexpected: ${extra.join(", ") || "none"}.`,
      );
    }

    // 2. Current state.
    const raw = await this.readRecord(spec, id);
    const current = spec.currentStandard(raw);

    // 3. Custom fields from fresh, complete metadata (fails closed).
    let prepared: PreparedCustomChanges = { requested: new Map(), expected: new Map() };
    if (Object.keys(customChangeInput).length > 0 || Object.keys(customExpectedInput).length > 0) {
      const index = await this.loadFieldIndex(spec.fieldEntity);
      prepared = {
        requested: this.resolveCustomInput(index, customChangeInput, spec.version),
        expected: this.resolveCustomInput(index, customExpectedInput, spec.version),
      };
      const customMissing = [...prepared.requested.keys()].filter((key) => !prepared.expected.has(key));
      const customExtra = [...prepared.expected.keys()].filter((key) => !prepared.requested.has(key));
      if (customMissing.length > 0 || customExtra.length > 0) {
        throw validation(
          `expected_before.custom_fields must contain exactly the changed custom fields. Missing: ${customMissing.map((key) => prepared.requested.get(key)?.field.name).join(", ") || "none"}. Unexpected: ${customExtra.map((key) => prepared.expected.get(key)?.field.name).join(", ") || "none"}.`,
        );
      }
    }
    const rawCustom = spec.rawCustom(raw);

    // 4. Conflict protection against edits made since the caller read the record.
    const conflicts: { field: string; expected: unknown; actual: unknown }[] = [];
    for (const key of standardKeys) {
      if (!sameStandard(key, standardExpected[key], current[key])) {
        conflicts.push({ field: key, expected: standardExpected[key], actual: current[key] ?? null });
      }
    }
    const currentCustom = new Map<string, CanonicalValue>();
    for (const [key, { field }] of prepared.requested) {
      const actual = canonicalFromRaw(field, rawCustom[key]);
      currentCustom.set(key, actual);
      const expected = prepared.expected.get(key);
      if (expected && !canonicalEquals(expected.canonical, actual)) {
        conflicts.push({ field: field.name, expected: readableValue(field, expected.canonical), actual: readableValue(field, actual) });
      }
    }
    if (conflicts.length > 0) {
      return {
        status: "conflict",
        entity: spec.entity,
        id,
        conflicts,
        message: `${spec.entity} ${id} changed since it was read. Nothing was written. Re-read it, show the human the revised before→after, and get renewed approval.`,
      };
    }

    // 5. Effective (non-no-op) changes.
    const effective: Json = {};
    for (const key of standardKeys) {
      if (!sameStandard(key, standardChanges[key], current[key])) effective[key] = standardChanges[key];
    }
    const effectiveCustom = [...prepared.requested.values()].filter(({ field, canonical }) => {
      const actual = currentCustom.get(field.key) ?? null;
      return !canonicalEquals(canonical, actual);
    });
    if (Object.keys(effective).length === 0 && effectiveCustom.length === 0) {
      return { status: "unchanged", entity: spec.entity, id, message: `${spec.entity} ${id} already has these values; nothing was written and no trace note was added.` };
    }

    // 6. Cross-field validation on the merged view, still before any write.
    if (typeof effective.owner_id === "number") await this.assertActiveOwner(effective.owner_id);
    if (plan.validateAfter) await plan.validateAfter(current, effective);

    // 7. Send only approved changed fields.
    const body: Json = { ...effective };
    if (effectiveCustom.length > 0) {
      const encoded = encodeCustomFields(effectiveCustom);
      if (spec.version === "v2") body.custom_fields = encoded;
      else Object.assign(body, encoded);
    }
    const endpoint = spec.recordPath(id);
    const envelope = await this.mutate("PATCH", spec.version, endpoint, body);
    this.mutationRecord(envelope, endpoint);

    // 8. Diff and trace.
    const owners = (await this.loadOwnerNames().catch(() => new Map<number, string>()));
    const labels = new Map<string, string>();
    if ("label_ids" in effective) {
      try {
        for (const label of (await this.listLeadLabels()).labels) labels.set(label.id, label.name);
      } catch {
        // Label names are cosmetic in the trace; ids are kept.
      }
    }
    const changes: DiffEntry[] = [];
    for (const key of Object.keys(effective)) {
      changes.push({
        field: fieldLabel(key),
        before: await this.displayValue(key, current[key], owners, labels),
        after: await this.displayValue(key, effective[key], owners, labels),
      });
    }
    for (const { field, canonical } of effectiveCustom) {
      changes.push({
        field: field.name,
        before: formatValue(readableValue(field, currentCustom.get(field.key) ?? null)),
        after: formatValue(readableValue(field, canonical)),
      });
    }
    const text = `Updated by agent for ${requestedBy} (${this.traceTimestamp()}): ${changes.map((change) => `${change.field} ${String(change.before)} → ${String(change.after)}`).join("; ")}.`;
    const trace = await this.recordTrace(spec.traceTarget(id), text);
    return this.appliedOutcome(spec.entity, id, changes, trace, "Updated");
  }

  private async createTraceAfterCreate(spec: EntitySpec, id: string | number, requestedBy: string, summary: string): Promise<WriteOutcome> {
    const trace = await this.recordTrace(spec.traceTarget(id), `Created by agent for ${requestedBy} (${this.traceTimestamp()}): ${summary}.`);
    return this.appliedOutcome(spec.entity, id, [{ field: "created", before: null, after: summary }], trace, "Created");
  }

  private duplicateOutcome(entity: WriteEntity, candidates: Map<string | number, { summary: string; matched_on: string[] }>, what: string): WriteOutcome | null {
    if (candidates.size === 0) return null;
    return {
      status: "duplicate_candidates",
      entity,
      candidates: [...candidates].map(([id, info]) => ({ id, ...info })),
      message: `Possible existing ${what} found; nothing was created. Use one of these records, or call again with data that clearly distinguishes a new ${what}.`,
    };
  }

  /**
   * Strict paged GET for duplicate checks: a malformed page, malformed row
   * (not an object, or a field of `required` missing or of the wrong type;
   * for `search`, no `item` object), malformed or non-advancing
   * pagination or hitting the page cap throws, so creation is blocked instead
   * of treating an unfinished scan as "no matches". Pagination metadata may be
   * absent only on a short page. `search` unwraps v2 search `data.items[].item`;
   * `list` expects `data` to be the row array.
   */
  private async scan<S extends RowShape>(what: string, version: FieldApiVersion, endpoint: string, query: Record<string, string | number>, shape: "search" | "list", required: S): Promise<ScannedRow<S>[]> {
    const items: ScannedRow<S>[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CHECK_PAGES; page += 1) {
      const pageQuery: Record<string, string | number> = { ...query, limit: DUPLICATE_CHECK_PAGE_SIZE };
      if (cursor !== null) pageQuery[version === "v2" ? "cursor" : "start"] = cursor;
      const data = await this.requestJson("GET", version, endpoint, pageQuery);
      const rows = shape === "search" ? (isRecord(data.data) ? data.data.items : undefined) : data.data;
      if (!Array.isArray(rows)) throw incompleteCheck(what);
      for (const row of rows) {
        const item = shape === "search" && isRecord(row) ? row.item : row;
        if (!isRecord(item) || !matchesRowShape(item, required)) throw incompleteCheck(what);
        items.push(item);
      }
      const next = this.nextScanPosition(what, version, data.additional_data, rows.length);
      if (next === null) return items;
      if (next === cursor) throw incompleteCheck(what);
      cursor = next;
    }
    throw incompleteCheck(what);
  }

  /** Next cursor/start of a scan page, or null when the scan is complete; throws on malformed or missing-on-full-page metadata. */
  private nextScanPosition(what: string, version: FieldApiVersion, additionalData: unknown, rowCount: number): string | null {
    const additional = isRecord(additionalData) ? additionalData : {};
    if (version === "v2") {
      const next = additional.next_cursor;
      if (typeof next === "string" && next !== "") return next;
      if (next === null) return null;
      if (next === undefined && rowCount < DUPLICATE_CHECK_PAGE_SIZE) return null;
      throw incompleteCheck(what);
    }
    const pagination = additional.pagination;
    if (pagination === undefined) {
      if (rowCount < DUPLICATE_CHECK_PAGE_SIZE) return null;
      throw incompleteCheck(what);
    }
    if (!isRecord(pagination) || typeof pagination.more_items_in_collection !== "boolean") throw incompleteCheck(what);
    if (!pagination.more_items_in_collection) return null;
    if (typeof pagination.next_start !== "number") throw incompleteCheck(what);
    return String(pagination.next_start);
  }

  /** Lead labels for a preflight: malformed data or rows throw instead of reading as "no labels". */
  private async listLeadLabelsStrict(): Promise<{ id: string; name: string; color: string | null }[]> {
    const data = await this.requestJson("GET", "v1", "leadLabels");
    if (!Array.isArray(data.data)) throw incompleteCheck("Lead label check");
    return data.data.map((row) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") throw incompleteCheck("Lead label check");
      return { id: row.id, name: row.name, color: typeof row.color === "string" ? row.color : null };
    });
  }

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------

  async createLead(params: CreateLeadParams): Promise<WriteOutcome> {
    this.assertWritable();
    if (params.person_id === undefined && params.organization_id === undefined) {
      throw validation("A lead needs at least one of person_id / organization_id.");
    }
    const custom = await this.resolveCustomForCreate("deal", params.custom_fields, "v1");
    if (params.owner_id !== undefined) await this.assertActiveOwner(params.owner_id);

    const matches = new Map<string | number, { summary: string; matched_on: string[] }>();
    const titleKey = normalizeName(params.title);
    const addLead = (id: string, title: string, archived: boolean, reason: string): void => {
      if (normalizeName(title) !== titleKey) return;
      const known = matches.get(id);
      matches.set(id, { summary: `${title}${archived ? " (archived)" : ""}`, matched_on: [...(known?.matched_on ?? []), reason] });
    };
    const found = await this.scan("Lead duplicate check", "v2", "leads/search", { term: params.title, fields: "title", exact_match: "true" }, "search", LEAD_ROW);
    for (const lead of found) addLead(String(lead.id), String(lead.title ?? ""), lead.is_archived === true, "same title");
    const links: Record<string, number>[] = [];
    if (params.person_id !== undefined) links.push({ person_id: params.person_id });
    if (params.organization_id !== undefined) links.push({ organization_id: params.organization_id });
    for (const link of links) {
      const linked = await this.scan("Lead duplicate check", "v1", "leads", { ...link, archived_status: "all" }, "list", LEAD_ROW);
      for (const lead of linked) addLead(String(lead.id), String(lead.title ?? ""), lead.is_archived === true, "same title on the same person/organization");
    }
    const duplicate = this.duplicateOutcome("lead", matches, "lead");
    if (duplicate) return duplicate;

    const body: Json = { title: params.title };
    for (const key of ["owner_id", "label_ids", "person_id", "organization_id", "value", "expected_close_date"] as const) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    Object.assign(body, encodeCustomFields(custom));
    const record = this.mutationRecord(await this.mutate("POST", "v1", "leads", body), "leads");
    return this.createTraceAfterCreate(LEAD_SPEC, String(record.id), params.requested_by, `lead "${params.title}"`);
  }

  async updateLead(params: UpdateLeadParams): Promise<WriteOutcome> {
    this.assertWritable();
    return this.updateRecord({
      spec: LEAD_SPEC,
      id: params.id,
      requestedBy: params.requested_by,
      changes: params.changes,
      expectedBefore: params.expected_before,
      validateAfter: async (current, effective) => {
        const after = { ...current, ...effective };
        if ((after.person_id ?? null) === null && (after.organization_id ?? null) === null) {
          throw validation("A lead must keep at least one of person_id / organization_id; this change would remove both links.");
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Deals
  // -------------------------------------------------------------------------

  async createDeal(params: CreateDealParams): Promise<WriteOutcome> {
    this.assertWritable();
    const custom = await this.resolveCustomForCreate("deal", params.custom_fields, "v2");
    if (params.owner_id !== undefined) await this.assertActiveOwner(params.owner_id);
    if (params.stage_id !== undefined) await this.assertStageInPipeline(params.stage_id, params.pipeline_id ?? null);

    const titleKey = normalizeName(params.title);
    const found = await this.scan("Deal duplicate check", "v2", "deals/search", { term: params.title, fields: "title", exact_match: "true" }, "search", DEAL_ROW);
    const matches = new Map<string | number, { summary: string; matched_on: string[] }>();
    for (const deal of found) {
      if (normalizeName(deal.title) !== titleKey) continue;
      const matched = ["same title"];
      if (params.person_id !== undefined && refId(deal.person) === params.person_id) matched.push("same person");
      if (params.org_id !== undefined && refId(deal.organization) === params.org_id) matched.push("same organization");
      matches.set(deal.id, { summary: `${String(deal.title)} (${String(deal.status ?? "unknown status")})`, matched_on: matched });
    }
    const duplicate = this.duplicateOutcome("deal", matches, "deal");
    if (duplicate) return duplicate;

    const body: Json = { title: params.title };
    for (const key of ["person_id", "org_id", "owner_id", "stage_id", "pipeline_id", "value", "currency", "expected_close_date"] as const) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    if (custom.length > 0) body.custom_fields = encodeCustomFields(custom);
    const record = this.mutationRecord(await this.mutate("POST", "v2", "deals", body), "deals");
    return this.createTraceAfterCreate(DEAL_SPEC, Number(record.id), params.requested_by, `deal "${params.title}"`);
  }

  async updateDeal(params: UpdateDealParams): Promise<WriteOutcome> {
    this.assertWritable();
    const { changes } = params;
    if (changes.lost_reason !== undefined && changes.status !== "lost") {
      throw validation("lost_reason can only be set together with status: lost.");
    }
    if (changes.expected_close_date === null) {
      throw validation("expected_close_date cannot be cleared on a deal: Pipedrive v2 rejects null (and turns an empty string into 0000-00-00). Set a real date or clear it in the Pipedrive UI.");
    }
    return this.updateRecord({
      spec: DEAL_SPEC,
      id: params.deal_id,
      requestedBy: params.requested_by,
      changes,
      expectedBefore: params.expected_before,
      validateAfter: async (_current, effective) => {
        const stageId = typeof effective.stage_id === "number" ? effective.stage_id : null;
        const pipelineId = typeof effective.pipeline_id === "number" ? effective.pipeline_id : null;
        if (pipelineId !== null && stageId === null) {
          throw validation("Changing pipeline_id also requires stage_id (a stage of that pipeline).");
        }
        if (stageId !== null) {
          await this.assertStageInPipeline(stageId, pipelineId ?? (typeof changes.pipeline_id === "number" ? changes.pipeline_id : null));
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Persons and organizations
  // -------------------------------------------------------------------------

  async createPerson(params: CreatePersonParams): Promise<WriteOutcome> {
    this.assertWritable();
    const custom = await this.resolveCustomForCreate("person", params.custom_fields, "v2");
    if (params.owner_id !== undefined) await this.assertActiveOwner(params.owner_id);
    if (params.name.trim().length < 2) throw validation("Person name needs at least 2 characters so duplicates can be checked.");

    const queries = [
      ...(params.emails ?? []).map((entry) => ({ term: entry.value, fields: "email", reason: `email ${entry.value}` })),
      ...(params.phones ?? []).map((entry) => ({ term: entry.value, fields: "phone", reason: `phone ${entry.value}` })),
      { term: params.name.trim(), fields: "name", reason: "same name" },
    ];
    const matches = new Map<string | number, { summary: string; matched_on: string[] }>();
    for (const query of queries) {
      if (query.term.length < 2) throw validation(`Cannot duplicate-check "${query.term}": search terms need at least 2 characters.`);
      const found = await this.scan("Person duplicate check", "v2", "persons/search", { term: query.term, fields: query.fields, exact_match: "true" }, "search", PERSON_ROW);
      for (const person of found) {
        const known = matches.get(person.id);
        const matched = [...(known?.matched_on ?? []), query.reason];
        const orgId = refId(person.organization);
        if (params.org_id !== undefined && orgId === params.org_id && !matched.includes("same organization")) matched.push("same organization");
        const orgName = isRecord(person.organization) && typeof person.organization.name === "string" ? person.organization.name : "none";
        matches.set(person.id, { summary: `${String(person.name ?? "")} (organization: ${orgName})`, matched_on: matched });
      }
    }
    const duplicate = this.duplicateOutcome("person", matches, "person");
    if (duplicate) return duplicate;

    const body: Json = { name: params.name };
    for (const key of ["org_id", "owner_id", "emails", "phones"] as const) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    if (custom.length > 0) body.custom_fields = encodeCustomFields(custom);
    const record = this.mutationRecord(await this.mutate("POST", "v2", "persons", body), "persons");
    return this.createTraceAfterCreate(PERSON_SPEC, Number(record.id), params.requested_by, `person "${params.name}"`);
  }

  async updatePerson(params: UpdatePersonParams): Promise<WriteOutcome> {
    this.assertWritable();
    return this.updateRecord({ spec: PERSON_SPEC, id: params.id, requestedBy: params.requested_by, changes: params.changes, expectedBefore: params.expected_before });
  }

  async createOrganization(params: CreateOrganizationParams): Promise<WriteOutcome> {
    this.assertWritable();
    const custom = await this.resolveCustomForCreate("organization", params.custom_fields, "v2");
    if (params.owner_id !== undefined) await this.assertActiveOwner(params.owner_id);
    if (params.name.trim().length < 2) throw validation("Organization name needs at least 2 characters so duplicates can be checked.");

    const queries = [
      { term: params.name.trim(), fields: "name", reason: "same name" },
      ...custom
        .filter(({ field, canonical }) => (typeof canonical === "string" || typeof canonical === "number") && /vat|tva|siren|siret/i.test(field.name))
        .map(({ field, canonical }) => ({ term: String(canonical), fields: "custom_fields", reason: `${field.name} ${String(canonical)}` })),
    ];
    const matches = new Map<string | number, { summary: string; matched_on: string[] }>();
    for (const query of queries) {
      if (query.term.length < 2) throw validation(`Cannot duplicate-check "${query.term}": search terms need at least 2 characters.`);
      const found = await this.scan("Organization duplicate check", "v2", "organizations/search", { term: query.term, fields: query.fields, exact_match: "true" }, "search", ORGANIZATION_ROW);
      for (const organization of found) {
        const known = matches.get(organization.id);
        const address = typeof organization.address === "string" && organization.address !== "" ? ` (${organization.address})` : "";
        matches.set(organization.id, { summary: `${String(organization.name ?? "")}${address}`, matched_on: [...(known?.matched_on ?? []), query.reason] });
      }
    }
    const duplicate = this.duplicateOutcome("organization", matches, "organization");
    if (duplicate) return duplicate;

    const body: Json = { name: params.name };
    for (const key of ["owner_id", "address"] as const) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    if (custom.length > 0) body.custom_fields = encodeCustomFields(custom);
    const record = this.mutationRecord(await this.mutate("POST", "v2", "organizations", body), "organizations");
    return this.createTraceAfterCreate(ORGANIZATION_SPEC, Number(record.id), params.requested_by, `organization "${params.name}"`);
  }

  async updateOrganization(params: UpdateOrganizationParams): Promise<WriteOutcome> {
    this.assertWritable();
    return this.updateRecord({ spec: ORGANIZATION_SPEC, id: params.id, requestedBy: params.requested_by, changes: params.changes, expectedBefore: params.expected_before });
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  private noteTarget(params: CreateNoteParams): NoteTarget {
    const targets: NoteTarget[] = [];
    if (params.lead_id !== undefined) targets.push({ lead_id: params.lead_id });
    if (params.deal_id !== undefined) targets.push({ deal_id: params.deal_id });
    if (params.person_id !== undefined) targets.push({ person_id: params.person_id });
    if (params.org_id !== undefined) targets.push({ org_id: params.org_id });
    if (targets.length !== 1) throw validation("Provide exactly one of lead_id, deal_id, person_id or org_id.");
    return targets[0];
  }

  async createNote(params: CreateNoteParams): Promise<WriteOutcome> {
    this.assertWritable();
    const target = this.noteTarget(params);
    const wanted = expectedNoteBody(params.content);
    const existing = (await this.listAllNotes(target)).find((note) => storedNoteBody(note.content) === wanted);
    if (existing) {
      return { status: "reused", entity: "note", id: existing.id, message: `An identical note already exists (note ${existing.id}); nothing was created.` };
    }
    const id = await this.postNote(target, renderNote(params.requested_by, params.content));
    return {
      status: "applied",
      applied: true,
      entity: "note",
      id,
      url: null,
      changes: [{ field: "note", before: null, after: params.content }],
      trace_status: "not_required",
      trace_note_id: null,
      trace_repair: null,
      partial_success: false,
      message: `Created note ${id} marked as agent-made for ${params.requested_by}.`,
    };
  }

  // -------------------------------------------------------------------------
  // Activities
  // -------------------------------------------------------------------------

  private withSubjectPrefix(subject: string): string {
    return subject.startsWith(ACTIVITY_SUBJECT_PREFIX) ? subject : `${ACTIVITY_SUBJECT_PREFIX}${subject}`;
  }

  async createActivity(params: CreateActivityParams): Promise<WriteOutcome> {
    this.assertWritable();
    const targetKeys = (["lead_id", "deal_id", "person_id", "org_id"] as const).filter((key) => params[key] !== undefined);
    if (targetKeys.length === 0) throw validation("An activity needs at least one of lead_id, deal_id, person_id or org_id.");
    if (params.owner_id !== undefined) {
      if (params.confirmed !== true) throw validation("Assigning an activity owner needs explicit human approval: set confirmed: true.");
      await this.assertActiveOwner(params.owner_id);
    }

    const subject = this.withSubjectPrefix(params.subject);
    const scanKey = targetKeys[0];
    const rows = await this.scan("Activity duplicate check", "v2", "activities", { [scanKey]: params[scanKey] as string | number }, "list", ACTIVITY_ROW);
    // Reuse only an activity that already satisfies every requested target and business field.
    const existing = rows.find(
      (row) =>
        bareSubject(row.subject) === bareSubject(params.subject) &&
        row.type === params.type &&
        targetKeys.every((key) => row[key] === params[key]) &&
        sameStandard("due_date", row.due_date ?? null, params.due_date ?? null) &&
        sameStandard("due_time", row.due_time ?? null, params.due_time ?? null) &&
        (params.duration === undefined || sameStandard("duration", row.duration ?? null, params.duration)) &&
        (params.note === undefined || noteMatchesText(row.note, params.note)) &&
        (params.done === undefined || (row.done === true) === params.done) &&
        (params.owner_id === undefined || row.owner_id === params.owner_id),
    );
    if (existing) {
      return { status: "reused", entity: "activity", id: Number(existing.id), message: `An identical activity already exists (activity ${String(existing.id)}); nothing was created.` };
    }

    const body: Json = {
      subject,
      type: params.type,
      note: renderActivityNote(params.requested_by, params.note ? escapedParagraph(params.note) : ""),
    };
    for (const key of ["lead_id", "deal_id", "org_id", "due_date", "due_time", "duration", "done", "owner_id"] as const) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    // v2 activities: person_id is read-only; the person is linked as the primary participant.
    if (params.person_id !== undefined) body.participants = [{ person_id: params.person_id, primary: true }];
    const record = this.mutationRecord(await this.mutate("POST", "v2", "activities", body), "activities");
    return {
      status: "applied",
      applied: true,
      entity: "activity",
      id: Number(record.id),
      url: null,
      changes: [{ field: "activity", before: null, after: subject }],
      trace_status: "not_required",
      trace_note_id: null,
      trace_repair: null,
      partial_success: false,
      message: `Created activity ${String(record.id)} marked as agent-made for ${params.requested_by}.`,
    };
  }

  async updateActivity(params: UpdateActivityParams): Promise<WriteOutcome> {
    this.assertWritable();
    const changes: Json = params.changes;
    const expected: Json = params.expected_before;
    const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
    if (keys.length === 0) throw validation("changes is empty: provide at least one field to change.");
    const missing = keys.filter((key) => expected[key] === undefined);
    const extra = Object.keys(expected).filter((key) => expected[key] !== undefined && !keys.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      throw validation(`expected_before must contain exactly the changed fields. Missing: ${missing.join(", ") || "none"}. Unexpected: ${extra.join(", ") || "none"}.`);
    }
    if (changes.owner_id !== undefined && params.confirmed !== true) {
      throw validation("Changing an activity owner needs explicit human approval: set confirmed: true.");
    }

    const endpoint = `activities/${params.id}`;
    const data = await this.requestJson("GET", "v2", endpoint);
    const raw = data.data;
    if (!isRecord(raw) || typeof raw.id !== "number") throw new PipedriveNotFoundError(`activity ${params.id} not found`, { endpoint, status: 404 });
    const current: Json = { subject: raw.subject, type: raw.type, due_date: raw.due_date, due_time: raw.due_time, duration: raw.duration, note: raw.note, done: raw.done === true, owner_id: raw.owner_id };

    const conflicts = keys
      .filter((key) => !sameStandard(key, expected[key], current[key]))
      .map((key) => ({ field: key, expected: expected[key], actual: current[key] ?? null }));
    if (conflicts.length > 0) {
      return { status: "conflict", entity: "activity", id: params.id, conflicts, message: `Activity ${params.id} changed since it was read. Nothing was written. Re-read it and retry with the current values.` };
    }
    const effectiveKeys = keys.filter((key) => !(key === "note" ? noteMatchesText(current.note, changes.note) : sameStandard(key, changes[key], current[key])));
    if (effectiveKeys.length === 0) {
      return { status: "unchanged", entity: "activity", id: params.id, message: `Activity ${params.id} already has these values; nothing was written.` };
    }
    if (typeof changes.owner_id === "number" && effectiveKeys.includes("owner_id")) await this.assertActiveOwner(changes.owner_id);

    const body: Json = {};
    for (const key of effectiveKeys) body[key] = key === "subject" ? this.withSubjectPrefix(String(changes.subject)) : changes[key];
    const diff: DiffEntry[] = effectiveKeys.map((key) => ({ field: fieldLabel(key), before: formatValue(current[key]), after: formatValue(changes[key]) }));
    const bodyHtml = effectiveKeys.includes("note") ? escapedParagraph(String(changes.note)) : stripAgentMarkers(typeof raw.note === "string" ? raw.note : "");
    body.note = renderActivityNote(
      params.requested_by,
      bodyHtml,
      // The note field holds the whole HTML body, so its update line only says it was edited (live sandbox: embedding it duplicated the marker text).
      `Agent update for ${params.requested_by} (${this.traceTimestamp()}): ${diff.map((entry) => (entry.field === fieldLabel("note") ? "Note edited" : `${entry.field} ${String(entry.before)} → ${String(entry.after)}`)).join("; ")}.`,
    );
    const record = this.mutationRecord(await this.mutate("PATCH", "v2", endpoint, body), endpoint);
    return {
      status: "applied",
      applied: true,
      entity: "activity",
      id: Number(record.id),
      url: null,
      changes: diff,
      trace_status: "not_required",
      trace_note_id: null,
      trace_repair: null,
      partial_success: false,
      message: `Updated activity ${String(record.id)}; the change is recorded in the activity note.`,
    };
  }

  // -------------------------------------------------------------------------
  // Lead labels (global definitions; trace goes on the audit lead)
  // -------------------------------------------------------------------------

  private async assertAuditLead(leadId: string): Promise<void> {
    await this.readRecord(LEAD_SPEC, leadId);
  }

  async createLeadLabel(params: CreateLeadLabelParams): Promise<WriteOutcome> {
    this.assertWritable();
    await this.assertAuditLead(params.audit_lead_id);
    const existing = (await this.listLeadLabelsStrict()).find((label) => normalizeName(label.name) === normalizeName(params.name));
    if (existing) {
      return { status: "reused", entity: "lead_label", id: existing.id, message: `A lead label named "${existing.name}" already exists (${existing.id}); nothing was created.` };
    }
    const color = params.color ?? "gray";
    const record = this.mutationRecord(await this.mutate("POST", "v1", "leadLabels", { name: params.name, color }), "leadLabels");
    const id = String(record.id);
    const trace = await this.recordTrace(
      { lead_id: params.audit_lead_id },
      `Lead label created by agent for ${params.requested_by} (${this.traceTimestamp()}): "${params.name}" (${color}), label ${id}. Lead labels are global definitions shared by every lead.`,
    );
    return this.appliedOutcome("lead_label", id, [{ field: "label", before: null, after: `${params.name} (${color})` }], trace, "Created");
  }

  async updateLeadLabel(params: UpdateLeadLabelParams): Promise<WriteOutcome> {
    this.assertWritable();
    const changes: Json = params.changes;
    const expected: Json = params.expected_before;
    const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
    if (keys.length === 0) throw validation("changes is empty: provide a new name and/or color.");
    const missing = keys.filter((key) => expected[key] === undefined);
    const extra = Object.keys(expected).filter((key) => expected[key] !== undefined && !keys.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      throw validation(`expected_before must contain exactly the changed fields. Missing: ${missing.join(", ") || "none"}. Unexpected: ${extra.join(", ") || "none"}.`);
    }
    await this.assertAuditLead(params.audit_lead_id);

    const labels = await this.listLeadLabelsStrict();
    const label = labels.find((candidate) => candidate.id === params.id);
    if (!label) throw new PipedriveNotFoundError(`lead label ${params.id} not found`, { endpoint: `leadLabels/${params.id}`, status: 404 });
    const current: Json = { name: label.name, color: label.color };
    const conflicts = keys
      .filter((key) => !sameStandard(key, expected[key], current[key]))
      .map((key) => ({ field: key, expected: expected[key], actual: current[key] ?? null }));
    if (conflicts.length > 0) {
      return { status: "conflict", entity: "lead_label", id: params.id, conflicts, message: `Lead label ${params.id} changed since it was read. Nothing was written.` };
    }
    const effective = keys.filter((key) => !sameStandard(key, changes[key], current[key]));
    if (effective.length === 0) {
      return { status: "unchanged", entity: "lead_label", id: params.id, message: `Lead label ${params.id} already has these values; nothing was written.` };
    }
    if (effective.includes("name")) {
      const clash = labels.find((candidate) => candidate.id !== params.id && normalizeName(candidate.name) === normalizeName(String(changes.name)));
      if (clash) {
        return {
          status: "duplicate_candidates",
          entity: "lead_label",
          candidates: [{ id: clash.id, summary: `${clash.name} (${clash.color ?? "no color"})`, matched_on: ["same name"] }],
          message: `Another lead label already uses the name "${clash.name}"; nothing was renamed. Use that label or pick a different name.`,
        };
      }
    }

    const body: Json = Object.fromEntries(effective.map((key) => [key, changes[key]]));
    const endpoint = `leadLabels/${params.id}`;
    this.mutationRecord(await this.mutate("PATCH", "v1", endpoint, body), endpoint);
    const diff: DiffEntry[] = effective.map((key) => ({ field: fieldLabel(key), before: formatValue(current[key]), after: formatValue(changes[key]) }));
    const trace = await this.recordTrace(
      { lead_id: params.audit_lead_id },
      `Lead label "${label.name}" (${params.id}) updated by agent for ${params.requested_by} (${this.traceTimestamp()}): ${diff.map((entry) => `${entry.field} ${String(entry.before)} → ${String(entry.after)}`).join("; ")}. This changes the label on EVERY lead that uses it.`,
    );
    return this.appliedOutcome("lead_label", params.id, diff, trace, "Updated");
  }

  // -------------------------------------------------------------------------
  // Lead → deal conversion
  // -------------------------------------------------------------------------

  async convertLeadToDeal(params: ConvertLeadToDealParams): Promise<WriteOutcome> {
    this.assertWritable();
    let conversionId = params.conversion_id;

    if (conversionId === undefined) {
      const raw = await this.readRecord(LEAD_SPEC, params.lead_id);
      const actualUpdate = typeof raw.update_time === "string" ? raw.update_time : null;
      if (actualUpdate !== params.expected_update_time) {
        return {
          status: "conflict",
          entity: "lead",
          id: params.lead_id,
          conflicts: [{ field: "update_time", expected: params.expected_update_time, actual: actualUpdate }],
          message: `Lead ${params.lead_id} changed since it was read. Nothing was converted. Re-read it and get renewed approval.`,
        };
      }
      if (raw.is_archived === true) throw validation("The lead is archived; unarchive it (update_lead) before converting.");
      await this.assertStageInPipeline(params.stage_id, params.pipeline_id ?? null);

      const title = typeof raw.title === "string" ? raw.title : "";
      const titleKey = normalizeName(title);
      const personId = typeof raw.person_id === "number" ? raw.person_id : null;
      const orgId = typeof raw.organization_id === "number" ? raw.organization_id : null;
      const found = await this.scan("Destination deal check", "v2", "deals/search", { term: title, fields: "title", exact_match: "true" }, "search", DEAL_ROW);
      const matches = new Map<string | number, { summary: string; matched_on: string[] }>();
      for (const deal of found) {
        if (normalizeName(deal.title) !== titleKey) continue;
        const samePerson = personId !== null && refId(deal.person) === personId;
        const sameOrg = orgId !== null && refId(deal.organization) === orgId;
        if (samePerson || sameOrg) {
          matches.set(deal.id, { summary: `${String(deal.title)} (${String(deal.status ?? "unknown status")})`, matched_on: ["same title", samePerson ? "same person" : "same organization"] });
        }
      }
      const duplicate = this.duplicateOutcome("deal", matches, "deal");
      if (duplicate) return duplicate;

      const endpoint = `leads/${params.lead_id}/convert/deal`;
      const body: Json = { stage_id: params.stage_id, ...(params.pipeline_id !== undefined ? { pipeline_id: params.pipeline_id } : {}) };
      const record = (await this.mutate("POST", "v2", endpoint, body)).data;
      const started = isRecord(record) && typeof record.conversion_id === "string" && record.conversion_id !== "" ? record.conversion_id : null;
      if (started === null) {
        throw new PipedriveOutcomeUnknownError(
          `Pipedrive accepted the conversion request for lead ${params.lead_id} but returned no conversion_id; it may have started. Check the lead and its deals before retrying.`,
          { endpoint },
        );
      }
      conversionId = started;
    }

    return this.awaitConversion(params, conversionId, params.requested_by);
  }

  private async awaitConversion(params: ConvertLeadToDealParams, conversionId: string, requestedBy: string): Promise<ConversionOutcome> {
    const endpoint = `leads/${params.lead_id}/convert/status/${conversionId}`;
    let status = "not_started";
    let dealId: number | null = null;

    let pollFailure: string | null = null;

    try {
      for (let attempt = 0; attempt < this.conversionPollAttempts; attempt += 1) {
        if (attempt > 0) await sleep(this.conversionPollDelayMs);
        const data = (await this.requestJson("GET", "v2", endpoint)).data;
        if (!isRecord(data) || typeof data.status !== "string") {
          throw new PipedriveError(`Malformed conversion status response for conversion ${conversionId}.`, { endpoint });
        }
        status = data.status;
        dealId = typeof data.deal_id === "number" ? data.deal_id : null;
        if (status === "completed" || status === "failed" || status === "rejected") break;
      }
    } catch (error) {
      // The conversion was already accepted: keep the handle so the caller can resume without re-sending it.
      pollFailure = error instanceof Error ? error.message : String(error);
      status = "unknown";
      dealId = null;
    }

    const base = { lead_id: params.lead_id, conversion_id: conversionId, conversion_status: status };
    if (status === "failed" || status === "rejected") {
      return { ...base, status: "failed", deal_id: null, trace_status: "not_required", trace_repair: null, partial_success: false, message: `Conversion ${conversionId} ${status}; no deal was created by it. Do not report the lead as converted.` };
    }
    if (pollFailure !== null) {
      return { ...base, status: "pending", deal_id: null, trace_status: "not_required", trace_repair: null, partial_success: false, message: `Conversion ${conversionId} was accepted but its status could not be read (${pollFailure}). It may already have created a deal. Call convert_lead_to_deal again with conversion_id ${conversionId} to resume status checks; this will not re-send the conversion. If the status stays unavailable (conversion status data expires after a few days), check the lead and its deals instead of converting again. Do not report it as converted yet.` };
    }
    if (status !== "completed" || dealId === null) {
      return { ...base, status: "pending", deal_id: null, trace_status: "not_required", trace_repair: null, partial_success: false, message: `Conversion ${conversionId} is still ${status}. Call convert_lead_to_deal again with conversion_id ${conversionId} to resume status checks; this will not re-send the conversion. Do not report it as converted yet.` };
    }

    const target: NoteTarget = { deal_id: dealId };
    const text = `Lead ${params.lead_id} → Deal ${dealId}: converted by agent for ${requestedBy} (conversion ${conversionId}, ${this.traceTimestamp()}).`;
    let notes: { id: number; content: string }[];
    try {
      notes = await this.listAllNotes(target);
    } catch {
      // Without a complete duplicate check, posting could duplicate the trace. No create_note repair is offered: a fresh timestamp would not match a trace that already landed, so resuming with the conversion_id (deduplicated by conversion id) is the only safe repair.
      return {
        ...base,
        status: "converted",
        deal_id: dealId,
        trace_status: "failed",
        trace_repair: null,
        partial_success: true,
        message: `Lead ${params.lead_id} converted to deal ${dealId}, but the existing notes could not be checked, so no trace note was posted (trace_status: failed). Repair it by calling convert_lead_to_deal again with conversion_id ${conversionId}: the trace is deduplicated by conversion id and this will not re-send the conversion. Do not use create_note for this trace; do not convert again.`,
      };
    }
    const existing = notes.find((note) => note.content.includes(`conversion ${conversionId}`));
    if (existing) {
      return { ...base, status: "converted", deal_id: dealId, trace_status: "created", trace_repair: null, partial_success: false, message: `Lead ${params.lead_id} converted to deal ${dealId}; the trace note already existed (note ${existing.id}).` };
    }
    const trace = await this.recordTrace(target, text);
    const partial = trace.status === "failed" || trace.status === "unknown";
    return {
      ...base,
      status: "converted",
      deal_id: dealId,
      trace_status: trace.status,
      trace_repair: trace.repair,
      partial_success: partial,
      message: partial
        ? `Lead ${params.lead_id} converted to deal ${dealId}, but the trace note is missing (trace_status: ${trace.status}). Repair it with create_note using trace_repair; do not convert again.`
        : `Lead ${params.lead_id} converted to deal ${dealId}.`,
    };
  }
}
