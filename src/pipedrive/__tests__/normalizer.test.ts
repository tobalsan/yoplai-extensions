import { describe, expect, it } from "vitest";

import { type FieldRegistry } from "../models.js";
import { normalizeCustomFields } from "../normalizer.js";

function registry(byKey: FieldRegistry["by_key"]): FieldRegistry {
  return { version: "test-v1", built_at: "2025-10-07T00:00:00Z", entity: "deal", by_key: byKey };
}

describe("normalizeCustomFields", () => {
  it("returns empty when registry is null", () => {
    const result = normalizeCustomFields({ some_hash: 123 }, null);
    expect(result.normalized_extra_fields).toEqual({});
    expect(result.normalized_field_metadata).toEqual({});
  });

  it("returns empty when there are no extra fields", () => {
    const result = normalizeCustomFields({}, registry({}));
    expect(result.normalized_extra_fields).toEqual({});
    expect(result.normalized_field_metadata).toEqual({});
  });

  it("resolves an enum int to its label with metadata", () => {
    const reg = registry({
      hash123: { name: "Status", type: "enum", options: { "1": "Active", "2": "Inactive" }, is_multiple: false },
    });
    const result = normalizeCustomFields({ hash123: 1 }, reg);
    expect(result.normalized_extra_fields.Status).toBe("Active");
    expect(result.normalized_field_metadata.Status).toEqual({ key: "hash123", type: "enum" });
  });

  it("keeps the raw value for an unknown enum option", () => {
    const reg = registry({
      hash123: { name: "Status", type: "enum", options: { "1": "Active" }, is_multiple: false },
    });
    const result = normalizeCustomFields({ hash123: 999 }, reg);
    expect(result.normalized_extra_fields.Status).toBe(999);
  });

  it("resolves a set of ids to labels", () => {
    const reg = registry({
      hash456: { name: "Categories", type: "set", options: { "10": "A", "11": "B", "12": "C" }, is_multiple: true },
    });
    const result = normalizeCustomFields({ hash456: [10, 11] }, reg);
    expect(result.normalized_extra_fields.Categories).toEqual(["A", "B"]);
  });

  it("normalizes monetary to {amount, currency}", () => {
    const reg = registry({
      hash789: { name: "Revenue", type: "monetary", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hash789: { value: 50000, currency: "USD" } }, reg);
    expect(result.normalized_extra_fields.Revenue).toEqual({ amount: 50000, currency: "USD" });
  });

  it("preserves malformed monetary values", () => {
    const reg = registry({
      hashMON: { name: "Budget", type: "monetary", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hashMON: "invalid" }, reg);
    expect(result.normalized_extra_fields.Budget).toBe("invalid");
  });

  it("normalizes a date range to {from, until}", () => {
    const reg = registry({
      hashABC: { name: "Contract Period", type: "daterange", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields(
      { hashABC: { value: "2025-01-01", until: "2025-12-31" } },
      reg,
    );
    expect(result.normalized_extra_fields["Contract Period"]).toEqual({
      from: "2025-01-01",
      until: "2025-12-31",
    });
  });

  it("coerces numeric int/double from strings", () => {
    const reg = registry({
      hashINT: { name: "Count", type: "int", options: null, is_multiple: false },
      hashDBL: { name: "Score", type: "double", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hashINT: "42", hashDBL: "3.14" }, reg);
    expect(result.normalized_extra_fields.Count).toBe(42);
    expect(result.normalized_extra_fields.Score).toBe(3.14);
  });

  it("passes through user/text and other simple types", () => {
    const reg = registry({
      hashUSR: { name: "Owner", type: "user", options: null, is_multiple: false },
      hashTXT: { name: "Notes", type: "text", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hashUSR: 123, hashTXT: "Some notes" }, reg);
    expect(result.normalized_extra_fields.Owner).toBe(123);
    expect(result.normalized_extra_fields.Notes).toBe("Some notes");
  });

  it("preserves null values", () => {
    const reg = registry({
      hashNULL: { name: "Optional", type: "varchar", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hashNULL: null }, reg);
    expect(result.normalized_extra_fields.Optional).toBeNull();
  });

  it("preserves unknown keys under a non-opaque name with type unknown", () => {
    const result = normalizeCustomFields({ unknownhash123456789: "some value" }, registry({}));
    expect(result.normalized_extra_fields).toHaveProperty("unknownh__unknown", "some value");
    const metaEntry = Object.values(result.normalized_field_metadata)[0];
    expect(metaEntry.type).toBe("unknown");
    expect(metaEntry.key).toBe("unknownhash123456789");
  });

  it("handles name collisions with a hash suffix", () => {
    const reg = registry({
      hash111: { name: "Manager", type: "user", options: null, is_multiple: false },
      hash222: { name: "Manager", type: "user", options: null, is_multiple: false },
    });
    const result = normalizeCustomFields({ hash111: 100, hash222: 200 }, reg);
    expect(result.normalized_extra_fields).toHaveProperty("Manager", 100);
    expect(result.normalized_extra_fields).toHaveProperty("Manager__hash222", 200);
  });

  it("applies system-field overrides for built-in hash-like keys", () => {
    const reg = registry({
      hashP: { name: "Priority", type: "enum", options: { "26": "High" }, is_multiple: false },
    });
    const result = normalizeCustomFields(
      {
        hashP: 26,
        owner_id: 42,
        local_won_date: "2024-01-15",
        label_ids: [1, 2],
        is_deleted: false,
      },
      reg,
    );
    expect(result.normalized_extra_fields.Priority).toBe("High");
    expect(result.normalized_extra_fields.Owner).toBe(42);
    expect(result.normalized_extra_fields["Local won date"]).toBe("2024-01-15");
    expect(result.normalized_extra_fields.Labels).toEqual([1, 2]);
    expect(result.normalized_extra_fields["Deleted flag"]).toBe(false);
  });
});
