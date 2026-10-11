import { type FieldMeta, type FieldRegistry } from "./models.js";

/**
 * System (built-in) deal fields whose payload keys are opaque/hash-like or
 * otherwise benefit from a human label. Keyed by the raw payload key. These
 * override / supplement the fetched dealField registry so built-in fields
 * resolve to readable names too.
 */
const SYSTEM_FIELD_OVERRIDES: Record<string, FieldMeta> = {
  owner_id: { name: "Owner", type: "user", options: null, is_multiple: false },
  user_id: { name: "Owner", type: "user", options: null, is_multiple: false },
  creator_user_id: { name: "Creator", type: "user", options: null, is_multiple: false },
  person_id: { name: "Person", type: "person", options: null, is_multiple: false },
  org_id: { name: "Organization", type: "org", options: null, is_multiple: false },
  local_won_date: { name: "Local won date", type: "date", options: null, is_multiple: false },
  local_lost_date: { name: "Local lost date", type: "date", options: null, is_multiple: false },
  local_close_date: { name: "Local close date", type: "date", options: null, is_multiple: false },
  label_ids: { name: "Labels", type: "set", options: null, is_multiple: true },
  is_deleted: { name: "Deleted flag", type: "boolean", options: null, is_multiple: false },
};

export interface NormalizeResult {
  normalized_extra_fields: Record<string, unknown>;
  normalized_field_metadata: Record<string, { key: string; type: string }>;
}

function emptyResult(): NormalizeResult {
  return { normalized_extra_fields: {}, normalized_field_metadata: {} };
}

/** Resolve field metadata for a raw payload key: registry first, then overrides. */
function resolveMeta(key: string, registry: FieldRegistry): FieldMeta | undefined {
  return registry.by_key[key] ?? SYSTEM_FIELD_OVERRIDES[key];
}

function coerceNumber(value: unknown, integer: boolean): unknown {
  if (typeof value === "number") return integer ? Math.trunc(value) : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a single raw value per its field type. */
function normalizeValue(value: unknown, meta: FieldMeta): unknown {
  if (value === null || value === undefined) return value;

  switch (meta.type) {
    case "enum": {
      const optionId = String(value);
      const label = meta.options?.[optionId];
      return label ?? value; // Unknown option → keep raw value
    }
    case "set": {
      if (!Array.isArray(value)) return value;
      if (!meta.options) return value;
      return value.map((item) => meta.options?.[String(item)] ?? item);
    }
    case "monetary": {
      if (!isRecord(value)) return value; // Malformed → preserve
      return { amount: value.value, currency: value.currency };
    }
    case "daterange":
    case "timerange": {
      if (!isRecord(value)) return value;
      return { from: value.value, until: value.until };
    }
    case "int":
      return coerceNumber(value, true);
    case "double":
      return coerceNumber(value, false);
    default:
      // user, org, person, varchar, text, url, date, boolean, etc. → pass through
      return value;
  }
}

/**
 * Turn a deal's raw custom-field hash-key map into human-readable, typed
 * values using the registry (+ system overrides). Names are collision-safe:
 * the first field to claim a name keeps it; later fields with the same name
 * get a `Name__<key>` suffix. Unknown keys are preserved as `<prefix>__unknown`
 * with type "unknown".
 *
 * Pure: no I/O, deterministic given (extraFields, registry).
 */
export function normalizeCustomFields(
  extraFields: Record<string, unknown> | null | undefined,
  registry: FieldRegistry | null | undefined,
): NormalizeResult {
  if (!registry) return emptyResult();
  if (!extraFields || Object.keys(extraFields).length === 0) return emptyResult();

  const result = emptyResult();
  const usedNames = new Set<string>();

  for (const [key, rawValue] of Object.entries(extraFields)) {
    const meta = resolveMeta(key, registry);

    if (!meta) {
      // Unknown key: preserve under a stable, non-opaque name.
      const name = `${key.slice(0, 8)}__unknown`;
      const finalName = usedNames.has(name) ? `${name}__${key}` : name;
      usedNames.add(finalName);
      result.normalized_extra_fields[finalName] = rawValue;
      result.normalized_field_metadata[finalName] = { key, type: "unknown" };
      continue;
    }

    // Collision-safe naming.
    const finalName = usedNames.has(meta.name) ? `${meta.name}__${key}` : meta.name;
    usedNames.add(finalName);

    result.normalized_extra_fields[finalName] = normalizeValue(rawValue, meta);
    result.normalized_field_metadata[finalName] = { key, type: meta.type };
  }

  return result;
}
