import { PipedriveValidationError } from "./errors.js";
import type { DealField } from "./models.js";

/** Pipedrive custom-field keys are 40-char hex hashes; standard fields use short names (title, owner_id, ...). */
const CUSTOM_KEY_PATTERN = /^[0-9a-f]{40}$/;

export type FieldApiVersion = "v1" | "v2";

/** A custom field that can receive writes. */
export interface WritableField {
  key: string;
  name: string;
  type: string;
  /** enum/set option id → label. */
  options: Record<string, string> | null;
}

export interface FieldIndex {
  byKey: Map<string, WritableField>;
  byName: Map<string, WritableField[]>;
}

/**
 * Canonical comparison form of a custom-field value; the same shape is built
 * from tool input, from `expected_before` and from the raw API record, so
 * equality means "no change".
 */
export type CanonicalValue =
  | null
  | string
  | number
  | string[]
  | { amount: number; currency: string }
  | { from: string; until: string };

export interface ResolvedCustomField {
  field: WritableField;
  canonical: CanonicalValue;
}

const TEXT_TYPES = new Set(["varchar", "varchar_auto", "text", "phone"]);
const REFERENCE_TYPES = new Set(["user", "org", "people"]);
/** Compound encodings for these types are not verified for v1 lead payloads, so leads fail closed. */
const COMPOUND_TYPES = new Set(["set", "monetary", "daterange", "timerange"]);

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function isCustomFieldKey(key: string): boolean {
  return CUSTOM_KEY_PATTERN.test(key);
}

/** Index of writable custom fields from complete field definitions. Standard fields are excluded. */
export function buildFieldIndex(definitions: DealField[]): FieldIndex {
  const byKey = new Map<string, WritableField>();
  const byName = new Map<string, WritableField[]>();
  for (const definition of definitions) {
    if (!isCustomFieldKey(definition.key)) continue;
    let options: Record<string, string> | null = null;
    if (definition.options && (definition.field_type === "enum" || definition.field_type === "set")) {
      options = {};
      for (const option of definition.options) options[String(option.id)] = option.label;
    }
    const field: WritableField = { key: definition.key, name: definition.name, type: definition.field_type, options };
    byKey.set(field.key, field);
    const nameKey = field.name.trim().toLowerCase();
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), field]);
  }
  return { byKey, byName };
}

/** Resolve an exact hash key or an unambiguous, case-insensitive field name. */
export function resolveField(index: FieldIndex, reference: string): WritableField {
  const exact = index.byKey.get(reference);
  if (exact) return exact;
  const matches = index.byName.get(reference.trim().toLowerCase()) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new PipedriveValidationError(
      `Custom field name "${reference}" is ambiguous; use one of these exact keys: ${matches.map((field) => field.key).join(", ")}.`,
    );
  }
  throw new PipedriveValidationError(
    `"${reference}" is not a known writable custom field. Standard and read-only fields cannot be set through custom_fields; use the tool's typed parameters.`,
  );
}

function invalid(field: WritableField, message: string): PipedriveValidationError {
  return new PipedriveValidationError(`Custom field "${field.name}" (${field.type}): ${message}`);
}

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Normalize HH:MM or HH:MM:SS to HH:MM:SS, or null when invalid. */
export function normalizeTime(value: string): string | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

function resolveOption(field: WritableField, input: unknown): string {
  const options = field.options ?? {};
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : null;
  if (text === null || text === "") throw invalid(field, "expected an option label or id");
  const matches = new Set<string>();
  if (hasOwn(options, text)) matches.add(text);
  for (const [id, label] of Object.entries(options)) {
    if (label.trim().toLowerCase() === text.toLowerCase()) matches.add(id);
  }
  if (matches.size === 1) return [...matches][0];
  const allowed = Object.entries(options).map(([id, label]) => `${label} (${id})`).join(", ");
  throw invalid(
    field,
    matches.size === 0 ? `unknown option "${text}". Allowed: ${allowed}` : `option "${text}" is ambiguous. Use an option id. Allowed: ${allowed}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Validate tool input for one custom field and convert it to its canonical form. */
export function toCanonical(field: WritableField, input: unknown, version: FieldApiVersion): CanonicalValue {
  if (version === "v1" && COMPOUND_TYPES.has(field.type)) {
    throw invalid(field, "set, monetary and range fields cannot be written on leads yet (the lead encoding is not verified); change them on the deal after conversion");
  }
  if (input === null) return null;
  const type = field.type;

  if (TEXT_TYPES.has(type)) {
    if (typeof input !== "string") throw invalid(field, "expected a string");
    return input === "" ? null : input;
  }
  if (type === "int") {
    if (typeof input !== "number" || !Number.isInteger(input)) throw invalid(field, "expected an integer");
    return input;
  }
  if (type === "double") {
    if (typeof input !== "number" || !Number.isFinite(input)) throw invalid(field, "expected a finite number");
    return input;
  }
  if (type === "date") {
    if (typeof input !== "string" || !isRealDate(input)) throw invalid(field, "expected a real date as YYYY-MM-DD");
    return input;
  }
  if (type === "time") {
    const time = typeof input === "string" ? normalizeTime(input) : null;
    if (time === null) throw invalid(field, "expected a time as HH:MM or HH:MM:SS");
    return time;
  }
  if (REFERENCE_TYPES.has(type)) {
    if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) throw invalid(field, "expected a positive integer id");
    return input;
  }
  if (type === "enum") return resolveOption(field, input);
  if (type === "set") {
    if (!Array.isArray(input)) throw invalid(field, "expected an array of option labels or ids");
    // Pipedrive rejects [] for multi-option fields; clearing is null.
    return input.length === 0 ? null : [...new Set(input.map((item) => resolveOption(field, item)))].sort();
  }
  if (type === "monetary") {
    const record = asRecord(input);
    const amount = record?.amount;
    const currency = record?.currency;
    if (typeof amount !== "number" || !Number.isFinite(amount) || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw invalid(field, "expected { amount: number, currency: three-letter ISO code }");
    }
    return { amount, currency };
  }
  if (type === "daterange" || type === "timerange") {
    const record = asRecord(input);
    const valid = (value: unknown): string | null =>
      typeof value !== "string" ? null : type === "daterange" ? (isRealDate(value) ? value : null) : normalizeTime(value);
    const from = valid(record?.from);
    const until = valid(record?.until);
    if (from === null || until === null || from > until) {
      throw invalid(field, `expected { from, until } as ${type === "daterange" ? "YYYY-MM-DD" : "HH:MM:SS"} with from <= until`);
    }
    return { from, until };
  }
  throw invalid(field, "this field type is not supported for writes");
}

function referenceId(value: unknown): number | null {
  const record = asRecord(value);
  const candidate = record ? (record.value ?? record.id) : value;
  const parsed = typeof candidate === "string" && candidate.trim() !== "" ? Number(candidate) : candidate;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** Canonical form of the value currently stored on a raw record (read side of the comparison). */
export function canonicalFromRaw(field: WritableField, raw: unknown): CanonicalValue {
  if (raw === undefined || raw === null || raw === "") return null;
  const type = field.type;
  if (type === "enum") {
    const id = referenceId(raw);
    return id === null ? String(raw) : String(id);
  }
  if (type === "set") {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return [...new Set(raw.map((item) => String(referenceId(item) ?? item)))].sort();
  }
  if (type === "monetary") {
    const record = asRecord(raw);
    const amount = Number(record?.value);
    return record && Number.isFinite(amount) && typeof record.currency === "string" ? { amount, currency: record.currency } : null;
  }
  if (type === "daterange" || type === "timerange") {
    const record = asRecord(raw);
    if (!record || typeof record.value !== "string" || typeof record.until !== "string") return null;
    const normalize = (value: string): string => (type === "timerange" ? (normalizeTime(value) ?? value) : value);
    return { from: normalize(record.value), until: normalize(record.until) };
  }
  if (type === "int" || type === "double") {
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  }
  if (REFERENCE_TYPES.has(type)) return referenceId(raw);
  if (type === "time") return typeof raw === "string" ? (normalizeTime(raw) ?? raw) : null;
  return typeof raw === "string" ? raw : null;
}

export function canonicalEquals(a: CanonicalValue, b: CanonicalValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Human-readable form of a canonical value (option ids become labels). */
export function readableValue(field: WritableField, canonical: CanonicalValue): unknown {
  if (field.type === "enum" && typeof canonical === "string") return field.options?.[canonical] ?? canonical;
  if (field.type === "set" && Array.isArray(canonical)) return canonical.map((id) => field.options?.[id] ?? id);
  return canonical;
}

function encodeValue(field: WritableField, canonical: CanonicalValue): unknown {
  if (canonical === null) return null;
  if (field.type === "enum" && typeof canonical === "string") return Number(canonical);
  if (field.type === "set" && Array.isArray(canonical)) return canonical.map(Number);
  if (field.type === "monetary" && typeof canonical === "object" && !Array.isArray(canonical) && "amount" in canonical) {
    return { value: canonical.amount, currency: canonical.currency };
  }
  if ((field.type === "daterange" || field.type === "timerange") && typeof canonical === "object" && !Array.isArray(canonical) && "from" in canonical) {
    return { value: canonical.from, until: canonical.until };
  }
  return canonical;
}

/**
 * API payload fragment for resolved custom fields: hash key → encoded value.
 * v2 callers nest it under `custom_fields`; v1 lead payloads spread it at the top level.
 */
export function encodeCustomFields(resolved: ResolvedCustomField[]): Record<string, unknown> {
  return Object.fromEntries(resolved.map(({ field, canonical }) => [field.key, encodeValue(field, canonical)]));
}
