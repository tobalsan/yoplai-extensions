/**
 * DraftGuard — the pure gate enforcing the project's #1 failure pin: **never
 * mutate a finalized/sent record**. Pennylane has no idempotency and finalizing
 * is irreversible, so every write tool must route its target through this guard
 * before touching it.
 *
 * The rule (§2.3, §2.4, §3.0):
 * - A customer **invoice** may be mutated only while it is an unfinalized draft
 *   (`draft === true`). Once finalized it is edit-locked; refuse.
 * - A **quote** may be mutated only while it is `pending`. Quotes have no draft
 *   state — a created quote is always `pending`; once `accepted`/`sent`/etc. it
 *   is customer-facing and must not be silently rewritten; refuse.
 *
 * It is pure and synchronous — no I/O, no client state, no dates-from-now — so
 * it can be unit-tested in isolation against its verdict. The mutable boundary
 * (which quote statuses count as "still editable") is a constructor parameter,
 * so loosening it later (e.g. also allowing a future "sent-but-editable" state)
 * is a parameter change, not a rewrite.
 */

/** The kind of record a decision is about. */
export type DraftGuardKind = "invoice" | "quote";

/**
 * The minimal record shape the guard inspects. Deliberately structural (not the
 * full Zod model) so the guard stays a pure decision over just the fields that
 * gate mutation. Anything with a boolean `draft` is treated as an invoice;
 * otherwise a `status` string is treated as a quote.
 */
export interface DraftGuardTarget {
  /** `true` for an unfinalized invoice draft. Present on customer invoices. */
  draft?: boolean | null;
  /** Quote status enum (`pending | accepted | denied | invoiced | expired`). */
  status?: string | null;
}

/** The guard's verdict: whether mutation is permitted, plus a human reason. */
export interface DraftGuardDecision {
  /** `true` when the target may be mutated. */
  allowed: boolean;
  /** Which record kind the decision was made against. */
  kind: DraftGuardKind;
  /** Human-readable explanation, suitable for surfacing to the caller. */
  reason: string;
}

/** Tuning knobs for the boundary, so it can loosen without a rewrite. */
export interface DraftGuardOptions {
  /**
   * Quote statuses that still permit mutation. Defaults to `["pending"]` — the
   * only editable state today. Widen this to loosen the boundary later.
   */
  editableQuoteStatuses?: readonly string[];
}

const DEFAULT_EDITABLE_QUOTE_STATUSES = ["pending"] as const;

/**
 * Pure, synchronous gate permitting mutation only of `draft: true` invoices and
 * `pending` quotes. Construct once (optionally widening the editable quote
 * statuses) and call `evaluate` (or the `permits` shorthand) per target.
 */
export class DraftGuard {
  private readonly editableQuoteStatuses: ReadonlySet<string>;

  constructor(options: DraftGuardOptions = {}) {
    this.editableQuoteStatuses = new Set(
      options.editableQuoteStatuses ?? DEFAULT_EDITABLE_QUOTE_STATUSES,
    );
  }

  /**
   * Decide whether `target` may be mutated. An invoice (anything carrying a
   * boolean `draft`) is editable only while `draft === true`; a quote is
   * editable only while its `status` is in the editable set. A record that is
   * neither (no `draft` boolean and no `status`) is refused — the guard fails
   * closed rather than guessing.
   */
  evaluate(target: DraftGuardTarget): DraftGuardDecision {
    if (typeof target.draft === "boolean") {
      return target.draft
        ? { allowed: true, kind: "invoice", reason: "invoice is an unfinalized draft" }
        : { allowed: false, kind: "invoice", reason: "invoice is finalized and cannot be edited" };
    }

    if (typeof target.status === "string") {
      return this.editableQuoteStatuses.has(target.status)
        ? { allowed: true, kind: "quote", reason: `quote is ${target.status} and still editable` }
        : {
            allowed: false,
            kind: "quote",
            reason: `quote is ${target.status}, not editable (only ${[...this.editableQuoteStatuses].join(", ")})`,
          };
    }

    return {
      allowed: false,
      kind: "invoice",
      reason: "target has neither a draft flag nor a status; refusing to mutate",
    };
  }

  /** Convenience predicate: `true` iff the target may be mutated. */
  permits(target: DraftGuardTarget): boolean {
    return this.evaluate(target).allowed;
  }
}
