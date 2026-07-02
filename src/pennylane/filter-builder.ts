/**
 * FilterBuilder — the single source of truth for the Pennylane filter DSL.
 *
 * Pennylane's list endpoints accept a `filter` query param: a URL-encoded JSON
 * array of `{field, operator, value}` clauses, **AND-combined** (there is no
 * OR). This module turns a list of clauses into exactly that param value.
 *
 * It is pure and synchronous — no I/O, no dates-from-now, no client state — so
 * it can be unit-tested in isolation against its encoded output.
 *
 * Ref: docs/specs/pennylane-api-reference.md §1.4.
 */

/** Comparison operators supported by the Pennylane filter DSL. */
export type FilterOperator =
  | "eq"
  | "not_eq"
  | "lt"
  | "lteq"
  | "gt"
  | "gteq"
  | "in"
  | "not_in"
  | "start_with";

/** Operators whose `value` is an array (everything else takes a scalar). */
const ARRAY_OPERATORS = new Set<FilterOperator>(["in", "not_in"]);

/** Scalar value accepted by non-array operators. Dates are ISO `YYYY-MM-DD`. */
export type FilterScalar = string | number | boolean;

/** A single filter clause. Array operators take `FilterScalar[]`. */
export interface FilterClause {
  field: string;
  operator: FilterOperator;
  value: FilterScalar | FilterScalar[];
}

/** Shape emitted into the JSON array sent to Pennylane. */
interface EncodedClause {
  field: string;
  operator: FilterOperator;
  value: FilterScalar | FilterScalar[];
}

function encodeClause(clause: FilterClause): EncodedClause {
  const { field, operator, value } = clause;

  if (ARRAY_OPERATORS.has(operator)) {
    if (!Array.isArray(value)) {
      throw new Error(`Operator "${operator}" on field "${field}" requires an array value`);
    }
    return { field, operator, value };
  }

  if (Array.isArray(value)) {
    throw new Error(`Operator "${operator}" on field "${field}" requires a scalar value`);
  }

  return { field, operator, value };
}

/**
 * Deep module: accumulate `{field, operator, value}` clauses, then produce the
 * `filter` query-param value. Clauses are AND-combined into one JSON array.
 * Chainable via `where`, or built directly from an array via `FilterBuilder.from`.
 */
export class FilterBuilder {
  private readonly clauses: FilterClause[] = [];

  /** Build a FilterBuilder from a list of clauses. */
  static from(clauses: readonly FilterClause[]): FilterBuilder {
    const builder = new FilterBuilder();
    for (const clause of clauses) {
      builder.where(clause);
    }
    return builder;
  }

  /** Add one clause. Returns `this` for chaining. */
  where(clause: FilterClause): this {
    this.clauses.push(clause);
    return this;
  }

  /** True when no clauses have been added (nothing to filter on). */
  isEmpty(): boolean {
    return this.clauses.length === 0;
  }

  /**
   * The JSON array string of AND-combined clauses (not URL-encoded). This is
   * what gets encoded into the `filter` param.
   */
  toJSON(): string {
    return JSON.stringify(this.clauses.map(encodeClause));
  }

  /**
   * The URL-encoded `filter` param value, ready to place in a query string. All
   * clauses are AND-combined into one JSON array. Returns `undefined` when there
   * are no clauses so callers can omit the param entirely.
   */
  build(): string | undefined {
    if (this.isEmpty()) {
      return undefined;
    }
    return encodeURIComponent(this.toJSON());
  }
}
