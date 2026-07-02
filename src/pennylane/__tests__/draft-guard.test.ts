import { describe, expect, it } from "vitest";
import { DraftGuard } from "../draft-guard.js";

describe("DraftGuard", () => {
  const guard = new DraftGuard();

  describe("invoices (gated on draft flag)", () => {
    it("permits mutation of a draft invoice", () => {
      const decision = guard.evaluate({ draft: true });
      expect(decision.allowed).toBe(true);
      expect(decision.kind).toBe("invoice");
    });

    it("refuses a finalized invoice", () => {
      const decision = guard.evaluate({ draft: false });
      expect(decision.allowed).toBe(false);
      expect(decision.kind).toBe("invoice");
      expect(decision.reason).toMatch(/finalized/i);
    });

    it("permits() is a boolean shorthand for the verdict", () => {
      expect(guard.permits({ draft: true })).toBe(true);
      expect(guard.permits({ draft: false })).toBe(false);
    });

    it("prefers the draft flag over any status when both are present", () => {
      // A finalized invoice may still carry a status string; draft: false wins.
      expect(guard.permits({ draft: false, status: "pending" })).toBe(false);
      expect(guard.permits({ draft: true, status: "accepted" })).toBe(true);
    });
  });

  describe("quotes (gated on status)", () => {
    it("permits a pending quote", () => {
      const decision = guard.evaluate({ status: "pending" });
      expect(decision.allowed).toBe(true);
      expect(decision.kind).toBe("quote");
    });

    it.each(["accepted", "sent", "denied", "invoiced", "expired"])(
      "refuses a %s quote",
      (status) => {
        const decision = guard.evaluate({ status });
        expect(decision.allowed).toBe(false);
        expect(decision.kind).toBe("quote");
        expect(decision.reason).toContain(status);
      },
    );
  });

  describe("fail-closed on unknown shapes", () => {
    it("refuses a target with neither draft flag nor status", () => {
      const decision = guard.evaluate({});
      expect(decision.allowed).toBe(false);
    });

    it("refuses when draft is null and no status is present", () => {
      expect(guard.permits({ draft: null })).toBe(false);
    });

    it("refuses when status is null", () => {
      expect(guard.permits({ status: null })).toBe(false);
    });
  });

  describe("configurable boundary (loosens by parameter, not rewrite)", () => {
    it("permits a widened quote status without touching the invoice rule", () => {
      const loosened = new DraftGuard({ editableQuoteStatuses: ["pending", "sent"] });
      expect(loosened.permits({ status: "sent" })).toBe(true);
      expect(loosened.permits({ status: "pending" })).toBe(true);
      expect(loosened.permits({ status: "accepted" })).toBe(false);
      // Invoice rule is unchanged.
      expect(loosened.permits({ draft: false })).toBe(false);
      expect(loosened.permits({ draft: true })).toBe(true);
    });
  });
});
