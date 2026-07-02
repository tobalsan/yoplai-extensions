import { describe, expect, it } from "vitest";
import { FilterBuilder, type FilterClause } from "../filter-builder.js";

/** Decode a built `filter` param back to the JSON array Pennylane receives. */
function decode(param: string | undefined): unknown {
  if (param === undefined) throw new Error("expected a built filter param");
  return JSON.parse(decodeURIComponent(param));
}

describe("FilterBuilder", () => {
  describe("per-operator encoding", () => {
    const scalarCases: Array<{ clause: FilterClause; expected: unknown }> = [
      {
        clause: { field: "external_reference", operator: "eq", value: "deal-42" },
        expected: { field: "external_reference", operator: "eq", value: "deal-42" },
      },
      {
        clause: { field: "status", operator: "not_eq", value: "draft" },
        expected: { field: "status", operator: "not_eq", value: "draft" },
      },
      {
        clause: { field: "date", operator: "lt", value: "2026-01-01" },
        expected: { field: "date", operator: "lt", value: "2026-01-01" },
      },
      {
        clause: { field: "date", operator: "lteq", value: "2026-06-30" },
        expected: { field: "date", operator: "lteq", value: "2026-06-30" },
      },
      {
        clause: { field: "date", operator: "gt", value: "2025-12-31" },
        expected: { field: "date", operator: "gt", value: "2025-12-31" },
      },
      {
        clause: { field: "date", operator: "gteq", value: "2025-06-01" },
        expected: { field: "date", operator: "gteq", value: "2025-06-01" },
      },
      {
        clause: { field: "name", operator: "start_with", value: "Acme" },
        expected: { field: "name", operator: "start_with", value: "Acme" },
      },
    ];

    for (const { clause, expected } of scalarCases) {
      it(`encodes ${clause.operator} on ${clause.field}`, () => {
        const param = FilterBuilder.from([clause]).build();
        expect(decode(param)).toEqual([expected]);
      });
    }

    it("encodes in with an array value", () => {
      const param = FilterBuilder.from([
        { field: "customer_id", operator: "in", value: [111, 222] },
      ]).build();
      expect(decode(param)).toEqual([
        { field: "customer_id", operator: "in", value: [111, 222] },
      ]);
    });

    it("encodes not_in with an array value", () => {
      const param = FilterBuilder.from([
        { field: "status", operator: "not_in", value: ["draft", "cancelled"] },
      ]).build();
      expect(decode(param)).toEqual([
        { field: "status", operator: "not_in", value: ["draft", "cancelled"] },
      ]);
    });
  });

  it("URL-encodes the JSON array so it is safe as a query param", () => {
    const param = FilterBuilder.from([
      { field: "date", operator: "gteq", value: "2025-06-01" },
    ]).build();
    // The raw JSON contains characters that must be percent-encoded.
    expect(param).not.toContain("[");
    expect(param).not.toContain("{");
    expect(param).not.toContain('"');
    expect(param).toContain("%5B"); // [
    expect(param).toContain("%7B"); // {
    expect(decodeURIComponent(param!)).toBe(
      '[{"field":"date","operator":"gteq","value":"2025-06-01"}]',
    );
  });

  it("AND-combines multiple clauses into a single filter param", () => {
    const param = FilterBuilder.from([
      { field: "external_reference", operator: "eq", value: "deal-7" },
      { field: "status", operator: "in", value: ["paid", "sent"] },
      { field: "date", operator: "gteq", value: "2025-06-01" },
      { field: "date", operator: "lteq", value: "2025-06-30" },
    ]).build();

    expect(decode(param)).toEqual([
      { field: "external_reference", operator: "eq", value: "deal-7" },
      { field: "status", operator: "in", value: ["paid", "sent"] },
      { field: "date", operator: "gteq", value: "2025-06-01" },
      { field: "date", operator: "lteq", value: "2025-06-30" },
    ]);
  });

  it("supports the fluent where() API", () => {
    const param = new FilterBuilder()
      .where({ field: "customer_id", operator: "eq", value: 42 })
      .where({ field: "draft", operator: "eq", value: true })
      .build();

    expect(decode(param)).toEqual([
      { field: "customer_id", operator: "eq", value: 42 },
      { field: "draft", operator: "eq", value: true },
    ]);
  });

  it("returns undefined when there are no clauses", () => {
    expect(new FilterBuilder().build()).toBeUndefined();
    expect(FilterBuilder.from([]).build()).toBeUndefined();
    expect(new FilterBuilder().isEmpty()).toBe(true);
  });

  it("rejects a scalar value for array operators", () => {
    expect(() =>
      FilterBuilder.from([{ field: "customer_id", operator: "in", value: 5 }]).build(),
    ).toThrow(/requires an array value/);
  });

  it("rejects an array value for scalar operators", () => {
    expect(() =>
      FilterBuilder.from([{ field: "date", operator: "eq", value: ["a", "b"] }]).build(),
    ).toThrow(/requires a scalar value/);
  });
});
