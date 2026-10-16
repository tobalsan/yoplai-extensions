import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  ConvertLeadToDealParamsSchema,
  CreateActivityParamsSchema,
  CreateDealParamsSchema,
  CreateLeadLabelParamsSchema,
  CreateLeadParamsSchema,
  CreateNoteParamsSchema,
  CreateOrganizationParamsSchema,
  CreatePersonParamsSchema,
  UpdateActivityParamsSchema,
  UpdateDealParamsSchema,
  UpdateLeadLabelParamsSchema,
  UpdateLeadParamsSchema,
  UpdateOrganizationParamsSchema,
  UpdatePersonParamsSchema,
  WriteOutcomeSchema,
} from "../write-models.js";
import { AUDIT_LEAD_ID, LABEL_ID, LEAD_ID } from "./write-helpers.js";

const base = { requested_by: "Éric", confirmed: true as const };

const ALL_SCHEMAS = {
  CreateLeadParamsSchema,
  UpdateLeadParamsSchema,
  CreateDealParamsSchema,
  UpdateDealParamsSchema,
  CreatePersonParamsSchema,
  UpdatePersonParamsSchema,
  CreateOrganizationParamsSchema,
  UpdateOrganizationParamsSchema,
  CreateNoteParamsSchema,
  CreateActivityParamsSchema,
  UpdateActivityParamsSchema,
  ConvertLeadToDealParamsSchema,
  CreateLeadLabelParamsSchema,
  UpdateLeadLabelParamsSchema,
};

describe("write parameter schemas", () => {
  it.each(Object.entries(ALL_SCHEMAS))("%s is a strict root object that converts to JSON Schema", (_name, schema) => {
    expect(schema).toBeInstanceOf(z.ZodObject);
    const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as { type?: string; additionalProperties?: unknown };
    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
  });

  it("requires a non-empty bounded requester name on every mutation tool", () => {
    expect(CreateLeadParamsSchema.safeParse({ ...base, title: "T", person_id: 1, requested_by: undefined }).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...base, title: "T", person_id: 1, requested_by: "   " }).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...base, title: "T", person_id: 1, requested_by: "x".repeat(101) }).success).toBe(false);
    expect(CreateNoteParamsSchema.safeParse({ deal_id: 1, content: "hi" }).success).toBe(false);
    expect(CreateNoteParamsSchema.parse({ requested_by: "  Éric ", deal_id: 1, content: "hi" }).requested_by).toBe("Éric");
  });

  it("requires literal confirmed: true on hard tools, with no default", () => {
    const hard = { requested_by: "Éric", title: "T", person_id: 1 };
    expect(CreateLeadParamsSchema.safeParse(hard).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...hard, confirmed: false }).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...hard, confirmed: "true" }).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...hard, confirmed: true }).success).toBe(true);
  });

  it("rejects unexpected keys at the root and inside changes", () => {
    expect(CreateLeadParamsSchema.safeParse({ ...base, title: "T", person_id: 1, force: true }).success).toBe(false);
    expect(
      UpdateDealParamsSchema.safeParse({ ...base, deal_id: 1, changes: { title: "x", surprise: 1 }, expected_before: { title: "y" } }).success,
    ).toBe(false);
    expect(
      UpdateDealParamsSchema.safeParse({ ...base, deal_id: 1, changes: { title: "x" }, expected_before: { title: "y", surprise: 1 } }).success,
    ).toBe(false);
  });

  it("rejects deleted deal status and accepts open/won/lost", () => {
    const params = (status: string) => ({ ...base, deal_id: 1, changes: { status }, expected_before: { status: "open" } });
    expect(UpdateDealParamsSchema.safeParse(params("deleted")).success).toBe(false);
    expect(UpdateDealParamsSchema.safeParse(params("all_not_deleted")).success).toBe(false);
    for (const status of ["open", "won", "lost"]) expect(UpdateDealParamsSchema.safeParse(params(status)).success).toBe(true);
  });

  it("rejects invalid ids, dates, currencies and amounts", () => {
    expect(UpdateLeadParamsSchema.safeParse({ ...base, id: "not-a-uuid", changes: { title: "a" }, expected_before: { title: "b" } }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", person_id: 0 }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", person_id: 1.5 }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", expected_close_date: "2026-02-30" }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", expected_close_date: "2026-2-3" }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", currency: "eur" }).success).toBe(false);
    expect(CreateDealParamsSchema.safeParse({ ...base, title: "D", value: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(CreateLeadParamsSchema.safeParse({ ...base, title: "T", person_id: 1, value: { amount: 1, currency: "EU" } }).success).toBe(false);
  });

  it("treats null as clear only for clearable fields and omission as unchanged", () => {
    const update = (changes: unknown, expected_before: unknown) => UpdateLeadParamsSchema.safeParse({ ...base, id: LEAD_ID, changes, expected_before });
    expect(update({ expected_close_date: null }, { expected_close_date: "2026-01-01" }).success).toBe(true);
    expect(update({ person_id: null }, { person_id: 4 }).success).toBe(true);
    expect(update({ title: null }, { title: "x" }).success).toBe(false);
    expect(update({ owner_id: null }, { owner_id: 1 }).success).toBe(false);
    const parsed = update({ title: "New" }, { title: "Old" });
    expect(parsed.success && "expected_close_date" in parsed.data.changes).toBe(false);
  });

  it("accepts read-tool shapes in expected_before (null labels, formatted_address, HH:MM) but not in changes", () => {
    const person = (emails: unknown, place: "changes" | "expected_before") =>
      UpdatePersonParamsSchema.safeParse({ ...base, id: 1, changes: { emails: place === "changes" ? emails : [] }, expected_before: { emails: place === "expected_before" ? emails : [] } });
    const readEmails = [{ label: null, value: "jane@acme.test", primary: true }];
    expect(person(readEmails, "expected_before").success).toBe(true);
    expect(person(readEmails, "changes").success).toBe(false);

    const readAddress = { formatted_address: "1 rue X", street_number: null, route: null, locality: null, sublocality: null, admin_area_level_1: null, admin_area_level_2: null, postal_code: "75001", country: "FR" };
    const organization = (address: unknown, place: "changes" | "expected_before") =>
      UpdateOrganizationParamsSchema.safeParse({ ...base, id: 1, changes: { address: place === "changes" ? address : { value: "x" } }, expected_before: { address: place === "expected_before" ? address : { value: "x" } } });
    expect(organization(readAddress, "expected_before").success).toBe(true);
    expect(organization(null, "expected_before").success).toBe(true);
    expect(organization(readAddress, "changes").success).toBe(false);

    const activity = (due_time: string, place: "changes" | "expected_before") =>
      UpdateActivityParamsSchema.safeParse({ requested_by: "Éric", id: 3, changes: { due_time: place === "changes" ? due_time : "10:00" }, expected_before: { due_time: place === "expected_before" ? due_time : "10:00" } });
    expect(activity("09:30:00", "expected_before").success).toBe(true);
    expect(activity("09:30:00", "changes").success).toBe(false);
    expect(activity("09:30", "changes").success).toBe(true);
  });

  it("validates contact arrays", () => {
    const person = (emails: unknown) => CreatePersonParamsSchema.safeParse({ ...base, name: "Jane Doe", emails });
    expect(person([{ value: "jane@acme.test", primary: true }]).success).toBe(true);
    expect(person([{ value: "not-an-email" }]).success).toBe(false);
    expect(person([{ value: "a@acme.test", primary: true }, { value: "b@acme.test", primary: true }]).success).toBe(false);
  });

  it("makes the activity confirmation optional (soft) and typed", () => {
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1 }).success).toBe(true);
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1, confirmed: false }).success).toBe(false);
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1, due_time: "25:00" }).success).toBe(false);
    // Live sandbox: POST /api/v2/activities with due_time "09:30:00" -> 400 "Validation failed: due_time: This value is not a valid datetime.; duration: This value is not valid."
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1, due_time: "09:30:00" }).success).toBe(false);
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1, duration: "00:45:00" }).success).toBe(false);
    expect(CreateActivityParamsSchema.safeParse({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1, due_time: "09:30", duration: "00:45" }).success).toBe(true);
    expect(
      UpdateActivityParamsSchema.safeParse({ requested_by: "Éric", id: 3, changes: { done: true }, expected_before: { done: false } }).success,
    ).toBe(true);
  });

  it("requires audit leads for label definition changes", () => {
    expect(CreateLeadLabelParamsSchema.safeParse({ ...base, name: "Hot" }).success).toBe(false);
    expect(CreateLeadLabelParamsSchema.safeParse({ ...base, name: "Hot", color: "pink", audit_lead_id: AUDIT_LEAD_ID }).success).toBe(false);
    expect(CreateLeadLabelParamsSchema.safeParse({ ...base, name: "Hot", color: "red", audit_lead_id: AUDIT_LEAD_ID }).success).toBe(true);
    expect(
      UpdateLeadLabelParamsSchema.safeParse({ ...base, id: LABEL_ID, changes: { name: "New" }, expected_before: { name: "Old" }, audit_lead_id: AUDIT_LEAD_ID }).success,
    ).toBe(true);
  });

  it("defines result schemas for every outcome kind", () => {
    const outcomes = [
      { status: "applied", applied: true, entity: "lead", id: LEAD_ID, url: null, changes: [], trace_status: "failed", trace_note_id: null, trace_repair: { target: { lead_id: LEAD_ID }, content: "c", instruction: "i" }, partial_success: true, message: "m" },
      { status: "unchanged", entity: "deal", id: 1, message: "m" },
      { status: "reused", entity: "note", id: 2, message: "m" },
      { status: "conflict", entity: "deal", id: 1, conflicts: [{ field: "title", expected: "a", actual: "b" }], message: "m" },
      { status: "duplicate_candidates", entity: "person", candidates: [{ id: 1, summary: "s", matched_on: ["email"] }], message: "m" },
      { status: "pending", lead_id: LEAD_ID, conversion_id: "c", deal_id: null, conversion_status: "running", trace_status: "not_required", trace_repair: null, partial_success: false, message: "m" },
    ];
    for (const outcome of outcomes) expect(WriteOutcomeSchema.safeParse(outcome).success).toBe(true);
  });
});
