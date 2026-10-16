import { describe, expect, it } from "vitest";

import { PipedriveValidationError } from "../errors.js";
import {
  buildFieldIndex,
  canonicalEquals,
  canonicalFromRaw,
  encodeCustomFields,
  readableValue,
  resolveField,
  toCanonical,
} from "../field-writer.js";
import type { DealField } from "../models.js";
import { DEAL_FIELDS, KEY_BUDGET, KEY_CATEGORY, KEY_NOTES, KEY_PERIOD, KEY_TAGS } from "./write-helpers.js";

const index = buildFieldIndex(DEAL_FIELDS.data as DealField[]);
const field = (reference: string) => resolveField(index, reference);

describe("resolveField", () => {
  it("accepts an exact hash key or a case-insensitive name", () => {
    expect(field(KEY_CATEGORY).name).toBe("Forecast category");
    expect(field("  FORECAST CATEGORY ").key).toBe(KEY_CATEGORY);
  });

  it("rejects standard fields and unknown names", () => {
    expect(() => field("title")).toThrow(PipedriveValidationError);
    expect(() => field("Title")).toThrow(/not a known writable custom field/);
    expect(() => field("Nope")).toThrow(/not a known writable custom field/);
  });

  it("rejects ambiguous names listing candidate keys instead of picking one", () => {
    const duplicated = buildFieldIndex([
      { id: 1, key: KEY_NOTES, name: "Region", field_type: "varchar" },
      { id: 2, key: KEY_BUDGET, name: "region", field_type: "varchar" },
    ]);
    expect(() => resolveField(duplicated, "Region")).toThrow(new RegExp(`ambiguous.*${KEY_NOTES}.*${KEY_BUDGET}`));
    expect(resolveField(duplicated, KEY_BUDGET).key).toBe(KEY_BUDGET);
  });
});

describe("toCanonical", () => {
  it("maps enum labels and ids to the option id and rejects unknown or ambiguous options", () => {
    expect(toCanonical(field("Forecast category"), "commit", "v2")).toBe("12");
    expect(toCanonical(field("Forecast category"), 11, "v2")).toBe("11");
    expect(() => toCanonical(field("Forecast category"), "Maybe", "v2")).toThrow(/unknown option "Maybe".*Allowed: Pipeline \(11\), Commit \(12\)/);

    const ambiguous = buildFieldIndex([
      { id: 1, key: KEY_NOTES, name: "Tier", field_type: "enum", options: [{ id: 1, label: "Gold" }, { id: 2, label: "gold" }] },
    ]);
    expect(() => toCanonical(resolveField(ambiguous, "Tier"), "GOLD", "v2")).toThrow(/ambiguous/);
  });

  it("canonicalizes sets as sorted unique ids", () => {
    expect(toCanonical(field("Segments"), ["Enterprise", "smb", 22], "v2")).toEqual(["21", "22"]);
    expect(() => toCanonical(field("Segments"), "SMB", "v2")).toThrow(/array/);
  });

  it("maps an empty set to null (Pipedrive rejects []) on both the input and the stored side", () => {
    expect(toCanonical(field("Segments"), [], "v2")).toBeNull();
    expect(canonicalFromRaw(field("Segments"), [])).toBeNull();
    const cleared = { field: field("Segments"), canonical: toCanonical(field("Segments"), [], "v2") };
    expect(encodeCustomFields([cleared])).toEqual({ [KEY_TAGS]: null });
  });

  it("validates monetary and range values", () => {
    expect(toCanonical(field("Budget"), { amount: 1200.5, currency: "EUR" }, "v2")).toEqual({ amount: 1200.5, currency: "EUR" });
    expect(() => toCanonical(field("Budget"), { amount: 1, currency: "eur" }, "v2")).toThrow(PipedriveValidationError);
    expect(toCanonical(field("Contract period"), { from: "2026-01-01", until: "2026-12-31" }, "v2")).toEqual({ from: "2026-01-01", until: "2026-12-31" });
    expect(() => toCanonical(field("Contract period"), { from: "2026-12-31", until: "2026-01-01" }, "v2")).toThrow(/from <= until/);
    expect(() => toCanonical(field("Contract period"), { from: "2026-02-30", until: "2026-03-01" }, "v2")).toThrow(PipedriveValidationError);
  });

  it("allows null to clear and turns empty text into a clear", () => {
    expect(toCanonical(field("Qualification notes"), null, "v2")).toBeNull();
    expect(toCanonical(field("Qualification notes"), "", "v2")).toBeNull();
    expect(toCanonical(field("Forecast category"), null, "v2")).toBeNull();
  });

  it("fails closed on unverified compound encodings for v1 lead payloads", () => {
    expect(() => toCanonical(field("Budget"), { amount: 1, currency: "EUR" }, "v1")).toThrow(/cannot be written on leads/);
    expect(() => toCanonical(field("Segments"), ["SMB"], "v1")).toThrow(/cannot be written on leads/);
    expect(toCanonical(field("Forecast category"), "Commit", "v1")).toBe("12");
  });

  it("rejects unsupported field types", () => {
    const address = buildFieldIndex([{ id: 1, key: KEY_NOTES, name: "Where", field_type: "address" }]);
    expect(() => toCanonical(resolveField(address, "Where"), "Paris", "v2")).toThrow(/not supported/);
  });
});

describe("encodeCustomFields", () => {
  it("encodes enum, set, monetary, range and null for the API", () => {
    const resolved = [
      ["Forecast category", "Commit"],
      ["Segments", ["SMB"]],
      ["Budget", { amount: 10, currency: "USD" }],
      ["Contract period", { from: "2026-01-01", until: "2026-02-01" }],
      ["Qualification notes", null],
    ].map(([name, value]) => ({ field: field(name as string), canonical: toCanonical(field(name as string), value, "v2") }));
    expect(encodeCustomFields(resolved)).toEqual({
      [KEY_CATEGORY]: 12,
      [KEY_TAGS]: [21],
      [KEY_BUDGET]: { value: 10, currency: "USD" },
      [KEY_PERIOD]: { value: "2026-01-01", until: "2026-02-01" },
      [KEY_NOTES]: null,
    });
  });
});

describe("canonicalFromRaw", () => {
  it("reads the stored API shapes back into the comparison form", () => {
    expect(canonicalFromRaw(field("Forecast category"), 12)).toBe("12");
    expect(canonicalFromRaw(field("Segments"), [22, 21])).toEqual(["21", "22"]);
    expect(canonicalFromRaw(field("Budget"), { value: 10, currency: "USD" })).toEqual({ amount: 10, currency: "USD" });
    expect(canonicalFromRaw(field("Contract period"), { value: "2026-01-01", until: "2026-02-01" })).toEqual({ from: "2026-01-01", until: "2026-02-01" });
    expect(canonicalFromRaw(field("Qualification notes"), undefined)).toBeNull();
    expect(canonicalFromRaw(field("Qualification notes"), "")).toBeNull();
  });

  it("compares and renders readable values", () => {
    expect(canonicalEquals(canonicalFromRaw(field("Forecast category"), 12), toCanonical(field("Forecast category"), "Commit", "v2"))).toBe(true);
    expect(readableValue(field("Forecast category"), "12")).toBe("Commit");
    expect(readableValue(field("Segments"), ["21", "22"])).toEqual(["SMB", "Enterprise"]);
  });
});
