import { describe, expect, it } from "vitest";

import {
  PipedriveAuthError,
  PipedriveError,
  PipedriveOutcomeUnknownError,
  PipedriveRateLimitError,
  PipedriveValidationError,
} from "../errors.js";
import { UpdateOrganizationParamsSchema, UpdatePersonParamsSchema, type WriteOutcome } from "../write-models.js";
import {
  AUDIT_LEAD_ID,
  DEAL_FIELDS,
  EMPTY_LIST,
  EMPTY_SEARCH,
  KEY_BUDGET,
  KEY_CATEGORY,
  KEY_NOTES,
  KEY_TAGS,
  KEY_VAT,
  LABEL_ID,
  LEAD_ID,
  NO_MORE,
  NOTE_CREATED,
  ORGANIZATION_FIELDS,
  USERS,
  jsonResponse,
  leadSearchPage,
  mockApi,
  useWriteClient,
} from "./write-helpers.js";

const { client } = useWriteClient();
const who = { requested_by: "Éric", confirmed: true as const };

function expectApplied(outcome: WriteOutcome): Extract<WriteOutcome, { status: "applied" }> {
  expect(outcome.status).toBe("applied");
  return outcome as Extract<WriteOutcome, { status: "applied" }>;
}

describe("write gate", () => {
  it("rejects every mutation with zero requests when allowWrite is off", async () => {
    const api = mockApi({});
    const off = client(false);
    const attempts: Array<() => Promise<unknown>> = [
      () => off.createLead({ ...who, title: "T", person_id: 1 }),
      () => off.updateLead({ ...who, id: LEAD_ID, changes: { title: "a" }, expected_before: { title: "b" } }),
      () => off.createDeal({ ...who, title: "T" }),
      () => off.updateDeal({ ...who, deal_id: 1, changes: { title: "a" }, expected_before: { title: "b" } }),
      () => off.createPerson({ ...who, name: "Jane Doe" }),
      () => off.updatePerson({ ...who, id: 1, changes: { name: "a" }, expected_before: { name: "b" } }),
      () => off.createOrganization({ ...who, name: "Acme" }),
      () => off.updateOrganization({ ...who, id: 1, changes: { name: "a" }, expected_before: { name: "b" } }),
      () => off.createNote({ requested_by: "Éric", deal_id: 1, content: "hi" }),
      () => off.createActivity({ requested_by: "Éric", subject: "Call", type: "call", deal_id: 1 }),
      () => off.updateActivity({ requested_by: "Éric", id: 1, changes: { done: true }, expected_before: { done: false } }),
      () => off.convertLeadToDeal({ ...who, lead_id: LEAD_ID, stage_id: 1, expected_update_time: "t" }),
      () => off.createLeadLabel({ ...who, name: "Hot", audit_lead_id: AUDIT_LEAD_ID }),
      () => off.updateLeadLabel({ ...who, id: LABEL_ID, changes: { name: "a" }, expected_before: { name: "b" }, audit_lead_id: AUDIT_LEAD_ID }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(PipedriveAuthError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("mutation transport", () => {
  const noteRoutes = (post: unknown) => ({ "GET /api/v1/notes": EMPTY_LIST, "POST /api/v1/notes": post });
  const note = { requested_by: "Éric", deal_id: 7, content: "Called back" };

  it("sends a JSON body with content-type, the api token and the right method/version", async () => {
    const api = mockApi(noteRoutes(NOTE_CREATED));
    await client().createNote(note);
    const [post] = api.to("POST /api/v1/notes");
    expect(post.query.get("api_token")).toBe("secret-token");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toEqual({ content: "<p>[Agent-made for Éric]</p><p>Called back</p>", deal_id: 7 });
  });

  it("retries an explicit 429 and then succeeds without duplicating the write result", async () => {
    const api = mockApi(noteRoutes([jsonResponse({}, 429, { "retry-after": "0" }), NOTE_CREATED]));
    const outcome = expectApplied(await client().createNote(note));
    expect(outcome.id).toBe(900);
    expect(api.to("POST /api/v1/notes")).toHaveLength(2);
  });

  it("gives up with a rate-limit error after bounded 429 retries", async () => {
    const api = mockApi(noteRoutes(jsonResponse({}, 429, { "retry-after": "0" })));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveRateLimitError);
    expect(api.to("POST /api/v1/notes")).toHaveLength(6);
  });

  it("never replays a mutation after a 5xx", async () => {
    const api = mockApi(noteRoutes(jsonResponse({ error: "boom" }, 502, { "retry-after": "0" })));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveOutcomeUnknownError);
    expect(api.to("POST /api/v1/notes")).toHaveLength(1);
  });

  it("never replays after a network failure and tells the caller to reconcile", async () => {
    let posts = 0;
    const api = mockApi(
      noteRoutes(() => {
        posts += 1;
        throw new TypeError("fetch failed");
      }),
    );
    await expect(client().createNote(note)).rejects.toThrow(/may or may not have been applied/);
    expect(posts).toBe(1);
    expect(api.to("POST /api/v1/notes")).toHaveLength(1);
  });

  it("treats malformed success bodies and missing ids as unknown outcomes", async () => {
    mockApi(noteRoutes(new Response("<html>oops</html>", { status: 200 })));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveOutcomeUnknownError);
    mockApi(noteRoutes({ success: true, data: {} }));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveOutcomeUnknownError);
  });

  it("treats success:false envelopes as failed writes and maps typed errors", async () => {
    mockApi(noteRoutes({ success: false, error: "nope" }));
    await expect(client().createNote(note)).rejects.toThrow(/rejected POST notes: nope/);
    mockApi(noteRoutes(jsonResponse({ error: "bad" }, 400)));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveValidationError);
    mockApi(noteRoutes(jsonResponse({ error: "forbidden" }, 403)));
    await expect(client().createNote(note)).rejects.toBeInstanceOf(PipedriveAuthError);
  });

  it("keeps GET retry behaviour for reads", async () => {
    const api = mockApi({ "GET /api/v1/users": [jsonResponse({}, 503, { "retry-after": "0" }), USERS] });
    const result = await client().listUsers();
    expect(result.count).toBe(3);
    expect(api.to("GET /api/v1/users")).toHaveLength(2);
  });
});

describe("create_lead", () => {
  const leadRoutes = (overrides: Record<string, unknown> = {}) => ({
    "GET /api/v2/leads/search": EMPTY_SEARCH,
    "GET /api/v1/leads": EMPTY_LIST,
    "GET /api/v1/dealFields": DEAL_FIELDS,
    "GET /api/v1/users": USERS,
    "POST /api/v1/leads": { success: true, data: { id: LEAD_ID } },
    "POST /api/v1/notes": NOTE_CREATED,
    ...overrides,
  });

  it("posts the v1 contract payload with custom fields at the top level, then a creation trace", async () => {
    const api = mockApi(leadRoutes());
    const outcome = expectApplied(
      await client().createLead({
        ...who,
        title: "ACME inbound",
        person_id: 11,
        organization_id: 22,
        owner_id: 5,
        label_ids: [LABEL_ID],
        value: { amount: 1500, currency: "EUR" },
        expected_close_date: "2026-12-01",
        custom_fields: { "Forecast category": "Commit", [KEY_NOTES]: "Warm intro" },
      }),
    );
    const [post] = api.to("POST /api/v1/leads");
    expect(post.body).toEqual({
      title: "ACME inbound",
      owner_id: 5,
      label_ids: [LABEL_ID],
      person_id: 11,
      organization_id: 22,
      value: { amount: 1500, currency: "EUR" },
      expected_close_date: "2026-12-01",
      [KEY_CATEGORY]: 12,
      [KEY_NOTES]: "Warm intro",
    });
    expect(post.body).not.toHaveProperty("confirmed");
    expect(post.body).not.toHaveProperty("requested_by");
    expect(outcome).toMatchObject({ id: LEAD_ID, trace_status: "created", partial_success: false });
    const [trace] = api.to("POST /api/v1/notes");
    expect(trace.body?.lead_id).toBe(LEAD_ID);
    expect(String(trace.body?.content)).toContain("Created by agent for Éric");
    expect(api.calls.at(-1)?.path).toBe("/api/v1/notes");
  });

  it("needs a person or organization link before any request", async () => {
    const api = mockApi(leadRoutes());
    await expect(client().createLead({ ...who, title: "No links" })).rejects.toThrow(/person_id \/ organization_id/);
    expect(api.calls).toHaveLength(0);
  });

  it("blocks creation when an archived same-title lead is linked to the person", async () => {
    const api = mockApi(
      leadRoutes({
        "GET /api/v1/leads": { data: [{ id: "arch-1", title: "acme inbound", is_archived: true }], additional_data: {} },
      }),
    );
    const outcome = await client().createLead({ ...who, title: "ACME inbound", person_id: 11 });
    expect(outcome).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: "arch-1", summary: "acme inbound (archived)" }] });
    expect(api.to("GET /api/v1/leads")[0].query.get("archived_status")).toBe("all");
    expect(api.to("POST /api/v1/leads")).toHaveLength(0);
  });

  it("rejects compound custom fields on leads before any write", async () => {
    const api = mockApi(leadRoutes());
    await expect(
      client().createLead({ ...who, title: "X", person_id: 1, custom_fields: { Budget: { amount: 5, currency: "EUR" } } }),
    ).rejects.toThrow(/cannot be written on leads/);
    expect(api.to("POST /api/v1/leads")).toHaveLength(0);
  });

  it("rejects inactive owners before writing", async () => {
    const api = mockApi(leadRoutes());
    await expect(client().createLead({ ...who, title: "X", person_id: 1, owner_id: 7 })).rejects.toThrow(/deactivated/);
    expect(api.to("POST /api/v1/leads")).toHaveLength(0);
  });

  it("duplicate-checks titles on v2 leads/search with cursor pagination across pages", async () => {
    const api = mockApi(
      leadRoutes({
        "GET /api/v2/leads/search": (call: { query: URLSearchParams }) =>
          call.query.get("cursor") === null
            ? leadSearchPage([{ id: "other-1", title: "Something else" }], "page-2")
            : leadSearchPage([{ id: "dup-1", title: "ACME inbound" }]),
      }),
    );
    const outcome = await client().createLead({ ...who, title: "ACME inbound", person_id: 11 });
    expect(outcome).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: "dup-1", matched_on: ["same title"] }] });
    const searches = api.to("GET /api/v2/leads/search");
    expect(searches.map((call) => call.query.get("cursor"))).toEqual([null, "page-2"]);
    expect(searches[0].query.get("exact_match")).toBe("true");
    expect(searches[0].query.get("fields")).toBe("title");
    expect(searches[0].query.has("start")).toBe(false);
    expect(api.to("POST /api/v1/leads")).toHaveLength(0);
  });

  it("blocks lead creation, with zero mutations, when a duplicate-check page is malformed or its pagination is unusable", async () => {
    const malformedPages: Record<string, unknown>[] = [
      { "GET /api/v2/leads/search": { data: { items: [{}] }, additional_data: { next_cursor: null } } },
      { "GET /api/v2/leads/search": { data: { items: [{ item: {} }] }, additional_data: { next_cursor: null } } },
      { "GET /api/v2/leads/search": { data: { items: [] }, additional_data: { next_cursor: 42 } } },
      { "GET /api/v1/leads": { data: [{ title: "no id" }], additional_data: { pagination: { more_items_in_collection: false } } } },
      { "GET /api/v1/leads": { data: [], additional_data: { pagination: {} } } },
      { "GET /api/v1/leads": { data: [], additional_data: { pagination: { more_items_in_collection: true } } } },
    ];
    for (const override of malformedPages) {
      const api = mockApi(leadRoutes(override));
      await expect(client().createLead({ ...who, title: "ACME inbound", person_id: 11 })).rejects.toThrow(/creation is blocked/);
      expect(api.to("POST /api/v1/leads")).toHaveLength(0);
      expect(api.to("POST /api/v1/notes")).toHaveLength(0);
    }
  });
});

describe("update flow (update_lead)", () => {
  const rawLead = (overrides: Record<string, unknown> = {}) => ({
    id: LEAD_ID,
    title: "Old title",
    owner_id: 5,
    label_ids: [LABEL_ID],
    person_id: 11,
    organization_id: null,
    is_archived: false,
    value: { amount: 100, currency: "EUR" },
    expected_close_date: "2026-10-01",
    update_time: "2026-10-01 10:00:00",
    [KEY_CATEGORY]: 11,
    ...overrides,
  });
  const routes = (lead: Record<string, unknown> = rawLead(), extra: Record<string, unknown> = {}) => ({
    [`GET /api/v1/leads/${LEAD_ID}`]: { success: true, data: lead },
    [`PATCH /api/v1/leads/${LEAD_ID}`]: { success: true, data: { id: LEAD_ID } },
    "GET /api/v1/dealFields": DEAL_FIELDS,
    "GET /api/v1/users": USERS,
    "GET /api/v1/leadLabels": { data: [{ id: LABEL_ID, name: "Hot", color: "red" }] },
    "POST /api/v1/notes": NOTE_CREATED,
    ...extra,
  });

  it("sends only approved changed fields, then a trace note with resolved names", async () => {
    const api = mockApi(routes());
    const outcome = expectApplied(
      await client().updateLead({
        ...who,
        id: LEAD_ID,
        changes: { owner_id: 6, is_archived: true, label_ids: [], custom_fields: { "Forecast category": "Commit" } },
        expected_before: { owner_id: 5, is_archived: false, label_ids: [LABEL_ID], custom_fields: { "Forecast category": "Pipeline" } },
      }),
    );
    const [patch] = api.to(`PATCH /api/v1/leads/${LEAD_ID}`);
    expect(patch.body).toEqual({ owner_id: 6, is_archived: true, label_ids: [], [KEY_CATEGORY]: 12 });
    expect(outcome.changes.map((change) => change.field)).toEqual(["Owner", "Is archived", "Label ids", "Forecast category"]);
    const trace = String(api.to("POST /api/v1/notes")[0].body?.content);
    expect(trace).toContain("Updated by agent for Éric");
    expect(trace).toContain("Owner Alice → Bob");
    expect(trace).toContain("Is archived false → true");
    expect(trace).toContain("Label ids Hot → empty");
    expect(trace).toContain("Forecast category Pipeline → Commit");
    expect(api.calls.map((call) => `${call.method} ${call.path}`).indexOf("POST /api/v1/notes")).toBeGreaterThan(
      api.calls.map((call) => `${call.method} ${call.path}`).indexOf(`PATCH /api/v1/leads/${LEAD_ID}`),
    );
  });

  it("returns a conflict and writes nothing when the record changed since it was read", async () => {
    const api = mockApi(routes(rawLead({ title: "Edited by a human" })));
    const outcome = await client().updateLead({
      ...who,
      id: LEAD_ID,
      changes: { title: "New" },
      expected_before: { title: "Old title" },
    });
    expect(outcome).toMatchObject({ status: "conflict", conflicts: [{ field: "title", expected: "Old title", actual: "Edited by a human" }] });
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it("conflicts on a stale custom field using readable values", async () => {
    const api = mockApi(routes(rawLead({ [KEY_CATEGORY]: 12 })));
    const outcome = await client().updateLead({
      ...who,
      id: LEAD_ID,
      changes: { custom_fields: { "Forecast category": "Commit" } },
      expected_before: { custom_fields: { "Forecast category": "Pipeline" } },
    });
    expect(outcome).toMatchObject({ status: "conflict", conflicts: [{ field: "Forecast category", expected: "Pipeline", actual: "Commit" }] });
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("treats a true no-op as unchanged: no PATCH and no trace note", async () => {
    const api = mockApi(routes());
    const outcome = await client().updateLead({ ...who, id: LEAD_ID, changes: { title: "Old title" }, expected_before: { title: "Old title" } });
    expect(outcome.status).toBe("unchanged");
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it("requires a non-empty patch and exact expected_before coverage before any request", async () => {
    const api = mockApi(routes());
    await expect(client().updateLead({ ...who, id: LEAD_ID, changes: {}, expected_before: {} })).rejects.toThrow(/changes is empty/);
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { title: "a", owner_id: 6 }, expected_before: { title: "b" } }),
    ).rejects.toThrow(/Missing: owner_id/);
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { title: "a" }, expected_before: { title: "b", owner_id: 5 } }),
    ).rejects.toThrow(/Unexpected: owner_id/);
    expect(api.calls).toHaveLength(0);
  });

  it("requires every changed custom field to have an expected value", async () => {
    const api = mockApi(routes());
    await expect(
      client().updateLead({
        ...who,
        id: LEAD_ID,
        changes: { custom_fields: { "Forecast category": "Commit", "Qualification notes": "x" } },
        expected_before: { custom_fields: { "Forecast category": "Pipeline" } },
      }),
    ).rejects.toThrow(/Missing: Qualification notes/);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("keeps at least one contact link on the lead", async () => {
    const api = mockApi(routes());
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { person_id: null }, expected_before: { person_id: 11 } }),
    ).rejects.toThrow(/at least one of person_id/);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("clears allowed fields with null", async () => {
    const api = mockApi(routes());
    await client().updateLead({
      ...who,
      id: LEAD_ID,
      changes: { expected_close_date: null, custom_fields: { "Forecast category": null } },
      expected_before: { expected_close_date: "2026-10-01", custom_fields: { "Forecast category": "Pipeline" } },
    });
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)[0].body).toEqual({ expected_close_date: null, [KEY_CATEGORY]: null });
  });

  it("uses fresh complete field metadata on every call and ignores the stale registry cache", async () => {
    const api = mockApi(routes());
    const params = (to: string, from: string) => ({
      ...who,
      id: LEAD_ID,
      changes: { custom_fields: { "Forecast category": to } },
      expected_before: { custom_fields: { "Forecast category": from } },
    });
    await client().updateLead(params("Commit", "Pipeline"));
    await client().updateLead(params("Commit", "Pipeline"));
    expect(api.to("GET /api/v1/dealFields")).toHaveLength(2);
  });

  it("fails closed when field metadata pagination cannot complete", async () => {
    const api = mockApi(
      routes(rawLead(), {
        "GET /api/v1/dealFields": { data: DEAL_FIELDS.data, additional_data: { pagination: { start: 0, limit: 500, more_items_in_collection: true, next_start: 0 } } },
      }),
    );
    await expect(
      client().updateLead({
        ...who,
        id: LEAD_ID,
        changes: { custom_fields: { "Forecast category": "Commit" } },
        expected_before: { custom_fields: { "Forecast category": "Pipeline" } },
      }),
    ).rejects.toBeInstanceOf(PipedriveError);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("fails closed, with zero mutations, on malformed field-definition pages", async () => {
    const malformed = [
      { data: DEAL_FIELDS.data, additional_data: { pagination: {} } },
      { data: [{ id: 1 }], additional_data: NO_MORE },
    ];
    for (const fields of malformed) {
      const api = mockApi(routes(rawLead(), { "GET /api/v1/dealFields": fields }));
      await expect(
        client().updateLead({
          ...who,
          id: LEAD_ID,
          changes: { custom_fields: { "Forecast category": "Commit" } },
          expected_before: { custom_fields: { "Forecast category": "Pipeline" } },
        }),
      ).rejects.toBeInstanceOf(PipedriveError);
      expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
      expect(api.to("POST /api/v1/notes")).toHaveLength(0);
    }
  });

  it("rejects unknown options and standard fields passed as custom fields before writing", async () => {
    const api = mockApi(routes());
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { custom_fields: { "Forecast category": "Maybe" } }, expected_before: { custom_fields: { "Forecast category": "Pipeline" } } }),
    ).rejects.toThrow(/unknown option "Maybe"/);
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { custom_fields: { title: "x" } }, expected_before: { custom_fields: { title: "y" } } }),
    ).rejects.toThrow(/not a known writable custom field/);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("does not trace or report success when the PATCH fails", async () => {
    const api = mockApi(routes(rawLead(), { [`PATCH /api/v1/leads/${LEAD_ID}`]: jsonResponse({ error: "invalid" }, 400) }));
    await expect(
      client().updateLead({ ...who, id: LEAD_ID, changes: { title: "New" }, expected_before: { title: "Old title" } }),
    ).rejects.toBeInstanceOf(PipedriveValidationError);
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it("reports partial success when the trace fails and a repair never replays the PATCH", async () => {
    const api = mockApi(
      routes(rawLead(), { "POST /api/v1/notes": jsonResponse({ error: "down" }, 400), "GET /api/v1/notes": EMPTY_LIST }),
    );
    const outcome = expectApplied(
      await client().updateLead({ ...who, id: LEAD_ID, changes: { title: "New" }, expected_before: { title: "Old title" } }),
    );
    expect(outcome).toMatchObject({ applied: true, id: LEAD_ID, trace_status: "failed", partial_success: true });
    expect(outcome.trace_repair).toMatchObject({ target: { lead_id: LEAD_ID } });
    expect(outcome.message).toMatch(/Do not report this as fully audited/);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(1);

    // Repair through the deduplicating create_note path.
    const repairApi = mockApi({ "GET /api/v1/notes": EMPTY_LIST, "POST /api/v1/notes": NOTE_CREATED });
    await client().createNote({ requested_by: "Éric", lead_id: LEAD_ID, content: outcome.trace_repair?.content ?? "" });
    expect(repairApi.to("POST /api/v1/notes")).toHaveLength(1);
    expect(api.to(`PATCH /api/v1/leads/${LEAD_ID}`)).toHaveLength(1);
  });

  it("reports an unknown trace outcome when the trace POST times out with a 5xx", async () => {
    mockApi(routes(rawLead(), { "POST /api/v1/notes": jsonResponse({}, 502) }));
    const outcome = expectApplied(
      await client().updateLead({ ...who, id: LEAD_ID, changes: { title: "New" }, expected_before: { title: "Old title" } }),
    );
    expect(outcome).toMatchObject({ trace_status: "unknown", partial_success: true });
  });

  it("repair of a trace that actually landed is reused, not duplicated", async () => {
    const content = "Updated by agent for Éric (2026-10-01T10:00:00Z): Title Old → New.";
    const api = mockApi({
      "GET /api/v1/notes": { data: [{ id: 41, content: `<p>${content}</p>` }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", lead_id: LEAD_ID, content });
    expect(outcome).toMatchObject({ status: "reused", id: 41 });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  // Live sandbox: POST /api/v1/notes {"content":"<p>[Agent-made for Éric]</p><p>a &amp; b</p>"} is stored and
  // returned as "<p>[Agent-made for Éric]</p><p>a & b</p>" (&amp; -> &, &quot; -> ", &#39; -> ', whitespace runs collapse).
  it("reuses an identical note although Pipedrive stored & unescaped", async () => {
    const api = mockApi({
      "GET /api/v1/notes": { data: [{ id: 43, content: "<p>[Agent-made for Éric]</p><p>ZZ note &lt;b&gt;html?&lt;/b&gt; & \"stuff\" it's</p>" }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", deal_id: 9, content: "ZZ note <b>html?</b> & \"stuff\"  it's" });
    expect(outcome).toMatchObject({ status: "reused", id: 43 });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  // Server-stored literal text `&quot;` (submitted as &amp;quot;) is stored as `&quot;`; a quote is stored as `"`.
  it.each([
    ["&quot;", "&quot;"],
    ["&#39;", "&#39;"],
    ["&amp;", "&amp;"],
  ])("reuses a note for literal entity text %s without creating a duplicate (stored as-is)", async (content, stored) => {
    const api = mockApi({
      "GET /api/v1/notes": { data: [{ id: 45, content: `<p>[Agent-made for Éric]</p><p>${stored}</p>` }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", deal_id: 9, content });
    expect(outcome).toMatchObject({ status: "reused", id: 45 });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it.each([
    ['"', "&quot;"],
    ["'", "&#39;"],
    ["&", "&amp;"],
    ["&quot;", '"'],
    ["&#39;", "'"],
  ])("does not reuse a note whose stored text differs: requested %s vs stored %s", async (content, stored) => {
    const api = mockApi({
      "GET /api/v1/notes": { data: [{ id: 44, content: `<p>[Agent-made for Éric]</p><p>${stored}</p>` }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", deal_id: 9, content });
    expect(outcome).toMatchObject({ status: "applied" });
    expect(api.to("POST /api/v1/notes")).toHaveLength(1);
  });

  it.each(['"', "'", "&"])("reuses a note with plain %s as Pipedrive stored it", async (content) => {
    const api = mockApi({
      "GET /api/v1/notes": { data: [{ id: 46, content: `<p>[Agent-made for Éric]</p><p>${content}</p>` }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", deal_id: 9, content });
    expect(outcome).toMatchObject({ status: "reused", id: 46 });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });
});

describe("deals", () => {
  const rawDeal = (overrides: Record<string, unknown> = {}) => ({
    id: 9,
    title: "Deal",
    value: 1000,
    currency: "EUR",
    status: "open",
    stage_id: 3,
    pipeline_id: 1,
    owner_id: 5,
    person_id: 11,
    org_id: 22,
    expected_close_date: "2026-10-01",
    custom_fields: { [KEY_BUDGET]: { value: 50, currency: "EUR" } },
    ...overrides,
  });
  const routes = (extra: Record<string, unknown> = {}) => ({
    "GET /api/v2/deals/9": { success: true, data: rawDeal() },
    "PATCH /api/v2/deals/9": { success: true, data: { id: 9 } },
    "GET /api/v1/dealFields": DEAL_FIELDS,
    "GET /api/v1/users": USERS,
    "GET /api/v2/stages/4": { data: { id: 4, name: "Proposal", pipeline_id: 1 } },
    "GET /api/v2/stages/8": { data: { id: 8, name: "Other", pipeline_id: 2 } },
    "POST /api/v1/notes": NOTE_CREATED,
    ...extra,
  });

  it("patches v2 deals with nested custom_fields and v2 naming (org_id, owner_id)", async () => {
    const api = mockApi(routes());
    await client().updateDeal({
      ...who,
      deal_id: 9,
      changes: {
        stage_id: 4,
        status: "lost",
        lost_reason: "Budget",
        org_id: 23,
        owner_id: 6,
        custom_fields: { Budget: { amount: 75, currency: "USD" } },
      },
      expected_before: {
        stage_id: 3,
        status: "open",
        lost_reason: null,
        org_id: 22,
        owner_id: 5,
        custom_fields: { Budget: { amount: 50, currency: "EUR" } },
      },
    });
    expect(api.to("PATCH /api/v2/deals/9")[0].body).toEqual({
      stage_id: 4,
      status: "lost",
      lost_reason: "Budget",
      org_id: 23,
      owner_id: 6,
      custom_fields: { [KEY_BUDGET]: { value: 75, currency: "USD" } },
    });
    expect(api.to("POST /api/v1/notes")[0].body).toMatchObject({ deal_id: 9 });
  });

  it("clears a multi-option field with null instead of an empty array, and treats [] as already cleared", async () => {
    const segments = { custom_fields: { Segments: ["SMB", "Enterprise"] } };
    const api = mockApi(routes({ "GET /api/v2/deals/9": { success: true, data: rawDeal({ custom_fields: { [KEY_TAGS]: [21, 22] } }) } }));
    await client().updateDeal({ ...who, deal_id: 9, changes: { custom_fields: { Segments: [] } }, expected_before: segments });
    expect(api.to("PATCH /api/v2/deals/9")[0].body).toEqual({ custom_fields: { [KEY_TAGS]: null } });

    const cleared = mockApi(routes({ "GET /api/v2/deals/9": { success: true, data: rawDeal({ custom_fields: { [KEY_TAGS]: [] } }) } }));
    const outcome = await client().updateDeal({ ...who, deal_id: 9, changes: { custom_fields: { Segments: [] } }, expected_before: { custom_fields: { Segments: [] } } });
    expect(outcome.status).toBe("unchanged");
    expect(cleared.to("PATCH /api/v2/deals/9")).toHaveLength(0);
  });

  it("rejects lost_reason without status lost, pipeline change without stage, and mismatched stage/pipeline", async () => {
    const api = mockApi(routes());
    await expect(
      client().updateDeal({ ...who, deal_id: 9, changes: { lost_reason: "x" }, expected_before: { lost_reason: null } }),
    ).rejects.toThrow(/only be set together with status: lost/);
    await expect(
      client().updateDeal({ ...who, deal_id: 9, changes: { pipeline_id: 2 }, expected_before: { pipeline_id: 1 } }),
    ).rejects.toThrow(/requires stage_id/);
    await expect(
      client().updateDeal({ ...who, deal_id: 9, changes: { stage_id: 8, pipeline_id: 1 }, expected_before: { stage_id: 3, pipeline_id: 1 } }),
    ).rejects.toThrow(/belongs to pipeline 2, not pipeline 1/);
    expect(api.to("PATCH /api/v2/deals/9")).toHaveLength(0);
  });

  // Live sandbox: PATCH /api/v2/deals/{id} {"expected_close_date": null} -> 400
  // {"success":false,"error":"Validation failed: expected_close_date: The value is not a valid 'string'.","code":"ERR_SCHEMA_VALIDATION_FAILED"}
  // and "" is stored as "0000-00-00", so clearing is refused before any request is sent.
  it("refuses to clear expected_close_date on a deal because Pipedrive v2 rejects null", async () => {
    const api = mockApi(routes());
    await expect(
      client().updateDeal({ ...who, deal_id: 9, changes: { expected_close_date: null }, expected_before: { expected_close_date: "2026-10-01" } }),
    ).rejects.toThrow(/expected_close_date cannot be cleared on a deal/);
    expect(api.to("PATCH /api/v2/deals/9")).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("creates deals via v2 after an exact-title search, validating stage against pipeline", async () => {
    const api = mockApi(
      routes({
        "GET /api/v2/deals/search": EMPTY_SEARCH,
        "POST /api/v2/deals": { success: true, data: { id: 31 } },
      }),
    );
    const outcome = expectApplied(
      await client().createDeal({ ...who, title: "New deal", org_id: 22, stage_id: 4, pipeline_id: 1, value: 10, currency: "EUR", custom_fields: { "Qualification notes": "n" } }),
    );
    expect(api.to("GET /api/v2/deals/search")[0].query.get("exact_match")).toBe("true");
    expect(api.to("POST /api/v2/deals")[0].body).toEqual({
      title: "New deal",
      org_id: 22,
      stage_id: 4,
      pipeline_id: 1,
      value: 10,
      currency: "EUR",
      custom_fields: { [KEY_NOTES]: "n" },
    });
    expect(outcome.id).toBe(31);
  });

  it("blocks deal creation on a duplicate found on a later search page", async () => {
    const api = mockApi(
      routes({
        "GET /api/v2/deals/search": (call: { query: URLSearchParams }) =>
          call.query.get("cursor") === null
            ? { data: { items: [{ item: { id: 1, title: "Other", status: "open" } }] }, additional_data: { next_cursor: "c2" } }
            : { data: { items: [{ item: { id: 2, title: "new deal", status: "won", person: { id: 11 }, organization: { id: 22 } } }] }, additional_data: {} },
      }),
    );
    const outcome = await client().createDeal({ ...who, title: "New deal", org_id: 22 });
    expect(outcome).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: 2, matched_on: ["same title", "same organization"] }] });
    expect(api.to("POST /api/v2/deals")).toHaveLength(0);
  });
});

describe("persons and organizations", () => {
  it("blocks person creation when any email, phone or name search finds a candidate", async () => {
    const api = mockApi({
      "GET /api/v2/persons/search": (call: { query: URLSearchParams }) =>
        call.query.get("fields") === "email"
          ? { data: { items: [{ item: { id: 5, name: "Jane D.", organization: { id: 22, name: "Acme" } } }] }, additional_data: {} }
          : EMPTY_SEARCH,
      "GET /api/v1/dealFields": DEAL_FIELDS,
      "POST /api/v2/persons": { success: true, data: { id: 50 } },
    });
    const outcome = await client().createPerson({
      ...who,
      name: "Jane Doe",
      org_id: 22,
      emails: [{ value: "jane@acme.test", primary: true }],
      phones: [{ value: "+33123456789" }],
    });
    expect(outcome).toMatchObject({
      status: "duplicate_candidates",
      candidates: [{ id: 5, summary: "Jane D. (organization: Acme)", matched_on: ["email jane@acme.test", "same organization"] }],
    });
    expect(api.to("GET /api/v2/persons/search").map((call) => call.query.get("fields"))).toEqual(["email", "phone", "name"]);
    expect(api.to("POST /api/v2/persons")).toHaveLength(0);
  });

  it("blocks creation when the search is truncated, failed or malformed instead of assuming no matches", async () => {
    // Distinct cursors forever: the page safety cap must block creation.
    let n = 0;
    const truncated = mockApi({
      "GET /api/v2/persons/search": () => ({ data: { items: [] }, additional_data: { next_cursor: `c${(n += 1)}` } }),
      "POST /api/v2/persons": { success: true, data: { id: 50 } },
    });
    await expect(client().createPerson({ ...who, name: "Jane Doe" })).rejects.toThrow(/creation is blocked/);
    expect(truncated.to("POST /api/v2/persons")).toHaveLength(0);

    // A cursor that does not advance is a loop, also blocked.
    mockApi({ "GET /api/v2/persons/search": { data: { items: [] }, additional_data: { next_cursor: "again" } } });
    await expect(client().createPerson({ ...who, name: "Jane Doe" })).rejects.toThrow(/creation is blocked/);

    const failed = mockApi({
      "GET /api/v2/persons/search": jsonResponse({ error: "bad" }, 400),
      "POST /api/v2/persons": { success: true, data: { id: 50 } },
    });
    await expect(client().createPerson({ ...who, name: "Jane Doe" })).rejects.toBeInstanceOf(PipedriveValidationError);
    expect(failed.to("POST /api/v2/persons")).toHaveLength(0);

    const malformed = mockApi({
      "GET /api/v2/persons/search": { data: null },
      "POST /api/v2/persons": { success: true, data: { id: 50 } },
    });
    await expect(client().createPerson({ ...who, name: "Jane Doe" })).rejects.toThrow(/creation is blocked/);
    expect(malformed.to("POST /api/v2/persons")).toHaveLength(0);
  });

  it("creates a person with the v2 contract payload and a trace note", async () => {
    const api = mockApi({
      "GET /api/v2/persons/search": EMPTY_SEARCH,
      "GET /api/v1/personFields": ORGANIZATION_FIELDS,
      "GET /api/v1/users": USERS,
      "POST /api/v2/persons": { success: true, data: { id: 50 } },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = expectApplied(
      await client().createPerson({ ...who, name: "Jane Doe", org_id: 22, owner_id: 5, emails: [{ value: "jane@acme.test", label: "work", primary: true }], phones: [{ value: "+33123456789" }], custom_fields: { "VAT number": "FR123" } }),
    );
    expect(api.to("POST /api/v2/persons")[0].body).toEqual({
      name: "Jane Doe",
      org_id: 22,
      owner_id: 5,
      emails: [{ value: "jane@acme.test", label: "work", primary: true }],
      phones: [{ value: "+33123456789" }],
      custom_fields: { [KEY_VAT]: "FR123" },
    });
    expect(outcome.id).toBe(50);
    expect(api.to("POST /api/v1/notes")[0].body).toMatchObject({ person_id: 50 });
  });

  it("updates persons with replacement contact lists and conflicts on a stale list", async () => {
    const rawPerson = { id: 50, name: "Jane", org_id: 22, owner_id: 5, emails: [{ value: "jane@acme.test", primary: true, label: "work" }], phones: [] };
    const api = mockApi({
      "GET /api/v2/persons/50": { success: true, data: rawPerson },
      "PATCH /api/v2/persons/50": { success: true, data: { id: 50 } },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const next = [{ value: "jane@acme.test", primary: true, label: "work" }, { value: "j@home.test" }];
    await client().updatePerson({ ...who, id: 50, changes: { emails: next }, expected_before: { emails: [{ value: "jane@acme.test", primary: true, label: "work" }] } });
    expect(api.to("PATCH /api/v2/persons/50")[0].body).toEqual({ emails: next });

    const stale = await client().updatePerson({ ...who, id: 50, changes: { emails: next }, expected_before: { emails: [{ value: "old@acme.test", primary: true, label: "work" }] } });
    expect(stale.status).toBe("conflict");
    expect(api.to("PATCH /api/v2/persons/50")).toHaveLength(1);
  });

  it("resolves VAT/SIREN by exact organization custom-field metadata and searches them for duplicates", async () => {
    const api = mockApi({
      "GET /api/v2/organizations/search": (call: { query: URLSearchParams }) =>
        call.query.get("fields") === "custom_fields"
          ? { data: { items: [{ item: { id: 8, name: "Acme SAS", address: "1 rue X" } }] }, additional_data: {} }
          : EMPTY_SEARCH,
      "GET /api/v1/organizationFields": ORGANIZATION_FIELDS,
      "POST /api/v2/organizations": { success: true, data: { id: 60 } },
    });
    const outcome = await client().createOrganization({ ...who, name: "Acme Group", custom_fields: { "VAT number": "FR123456789" } });
    expect(outcome).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: 8, matched_on: ["VAT number FR123456789"] }] });
    const search = api.to("GET /api/v2/organizations/search").find((call) => call.query.get("fields") === "custom_fields");
    expect(search?.query.get("term")).toBe("FR123456789");
    expect(api.to("POST /api/v2/organizations")).toHaveLength(0);
  });

  it("updates organization address and VAT through custom fields (compared by address line)", async () => {
    const api = mockApi({
      "GET /api/v2/organizations/60": { success: true, data: { id: 60, name: "Acme", owner_id: 5, address: { value: "1 rue X, Paris" }, custom_fields: { [KEY_VAT]: "FR1" } } },
      "PATCH /api/v2/organizations/60": { success: true, data: { id: 60 } },
      "GET /api/v1/organizationFields": ORGANIZATION_FIELDS,
      "POST /api/v1/notes": NOTE_CREATED,
    });
    await client().updateOrganization({
      ...who,
      id: 60,
      changes: { address: { value: "2 rue Y, Lyon", country: "FR" }, custom_fields: { [KEY_VAT]: "FR2" } },
      expected_before: { address: { value: "1 rue X, Paris" }, custom_fields: { "VAT number": "FR1" } },
    });
    expect(api.to("PATCH /api/v2/organizations/60")[0].body).toEqual({
      address: { value: "2 rue Y, Lyon", country: "FR" },
      custom_fields: { [KEY_VAT]: "FR2" },
    });
  });
});

describe("persons and organizations: preflight strictness and read round-trips", () => {
  it("blocks person creation, with zero mutations, on rows without an item or id and on a full page without pagination", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ item: { id: index + 1, name: `Someone ${index}` } }));
    const pages = [
      { data: { items: [{}] }, additional_data: {} },
      { data: { items: [{ item: {} }] }, additional_data: {} },
      { data: { items: fullPage }, additional_data: {} },
    ];
    for (const page of pages) {
      const api = mockApi({ "GET /api/v2/persons/search": page, "POST /api/v2/persons": { success: true, data: { id: 50 } } });
      await expect(client().createPerson({ ...who, name: "Jane Doe" })).rejects.toThrow(/creation is blocked/);
      expect(api.to("POST /api/v2/persons")).toHaveLength(0);
    }
  });

  const rawOrg = (address: Record<string, unknown>) => ({
    "GET /api/v2/organizations/60": { success: true, data: { id: 60, name: "Acme", owner_id: 5, address } },
    "PATCH /api/v2/organizations/60": { success: true, data: { id: 60 } },
    "GET /api/v1/organizationFields": ORGANIZATION_FIELDS,
    "POST /api/v1/notes": NOTE_CREATED,
  });
  const parisAddress = { value: "1 rue X, Paris", postal_code: "75001", country: "FR" };

  it("applies a component-only address correction and shows it in the trace", async () => {
    const api = mockApi(rawOrg(parisAddress));
    const outcome = await client().updateOrganization({
      ...who,
      id: 60,
      changes: { address: { value: "1 rue X, Paris", postal_code: "75002", country: "FR" } },
      expected_before: { address: parisAddress },
    });
    expect(outcome.status).toBe("applied");
    expect(api.to("PATCH /api/v2/organizations/60")[0].body).toEqual({ address: { value: "1 rue X, Paris", postal_code: "75002", country: "FR" } });
    expect(String(api.to("POST /api/v1/notes")[0].body?.content)).toContain("postal_code 75002");
  });

  it("conflicts on a stale address component and treats a fully identical address as unchanged", async () => {
    const api = mockApi(rawOrg(parisAddress));
    const stale = await client().updateOrganization({
      ...who,
      id: 60,
      changes: { address: { value: "1 rue X, Paris", postal_code: "75002", country: "FR" } },
      expected_before: { address: { value: "1 rue X, Paris", postal_code: "69000", country: "FR" } },
    });
    expect(stale).toMatchObject({ status: "conflict", conflicts: [{ field: "address" }] });
    const same = await client().updateOrganization({ ...who, id: 60, changes: { address: parisAddress }, expected_before: { address: parisAddress } });
    expect(same.status).toBe("unchanged");
    expect(api.to("PATCH /api/v2/organizations/60")).toHaveLength(0);
  });

  it("accepts get_person and get_organization output as expected_before", async () => {
    const api = mockApi({
      "GET /api/v2/persons/50": { success: true, data: { id: 50, name: "Jane", org_id: 22, emails: [{ value: "jane@acme.test", primary: true }], phones: [{ value: "+33123456789", label: null }] } },
      "PATCH /api/v2/persons/50": { success: true, data: { id: 50 } },
      ...rawOrg(parisAddress),
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const person = await client().getPerson(50);
    expect(person.emails).toEqual([{ label: null, value: "jane@acme.test", primary: true }]);
    const personUpdate = UpdatePersonParamsSchema.parse({
      ...who,
      id: 50,
      changes: { emails: [{ value: "jane@acme.test", primary: true }, { value: "j@home.test" }] },
      expected_before: { emails: person.emails },
    });
    expect((await client().updatePerson(personUpdate)).status).toBe("applied");
    expect(api.to("PATCH /api/v2/persons/50")).toHaveLength(1);

    const organization = await client().getOrganization(60);
    expect(organization.address).toMatchObject({ formatted_address: "1 rue X, Paris", postal_code: "75001", country: "FR" });
    const orgUpdate = UpdateOrganizationParamsSchema.parse({
      ...who,
      id: 60,
      changes: { address: { value: "2 rue Y, Lyon" } },
      expected_before: { address: organization.address },
    });
    expect((await client().updateOrganization(orgUpdate)).status).toBe("applied");
    expect(api.to("PATCH /api/v2/organizations/60")[0].body).toEqual({ address: { value: "2 rue Y, Lyon" } });
  });
});

describe("notes", () => {
  it("reuses an identical existing note found on a later page and never posts", async () => {
    const api = mockApi({
      "GET /api/v1/notes": (call: { query: URLSearchParams }) =>
        call.query.get("start") === null
          ? { data: [{ id: 1, content: "<p>other</p>" }], additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } } }
          : { data: [{ id: 2, content: "<p>[Agent-made for Sam]</p><p>Called back & agreed</p>" }], additional_data: {} },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createNote({ requested_by: "Éric", org_id: 4, content: "Called back & agreed" });
    expect(outcome).toMatchObject({ status: "reused", id: 2 });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
    expect(api.to("GET /api/v1/notes")[0].query.get("org_id")).toBe("4");
  });

  it("blocks note creation when the existing-notes scan is truncated", async () => {
    let start = 0;
    const api = mockApi({
      "GET /api/v1/notes": () => ({ data: [], additional_data: { pagination: { more_items_in_collection: true, next_start: (start += 100) } } }),
      "POST /api/v1/notes": NOTE_CREATED,
    });
    await expect(client().createNote({ requested_by: "Éric", deal_id: 1, content: "x" })).rejects.toThrow(/creation is blocked/);
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it("requires exactly one target and HTML-escapes content and requester once", async () => {
    const api = mockApi({ "GET /api/v1/notes": EMPTY_LIST, "POST /api/v1/notes": NOTE_CREATED });
    await expect(client().createNote({ requested_by: "Éric", content: "x" })).rejects.toThrow(/exactly one/);
    await expect(client().createNote({ requested_by: "Éric", deal_id: 1, org_id: 2, content: "x" })).rejects.toThrow(/exactly one/);
    await client().createNote({ requested_by: "<b>Éric</b>", lead_id: LEAD_ID, content: "<img src=x onerror=alert(1)> & more" });
    const content = String(api.to("POST /api/v1/notes")[0].body?.content);
    expect(content).toBe("<p>[Agent-made for &lt;b&gt;Éric&lt;/b&gt;]</p><p>&lt;img src=x onerror=alert(1)&gt; &amp; more</p>");
    expect(content.match(/Agent-made/g)).toHaveLength(1);
  });
});

describe("activities", () => {
  const rawActivity = (overrides: Record<string, unknown> = {}) => ({
    id: 70,
    subject: "Discovery call",
    type: "call",
    deal_id: 9,
    done: false,
    due_date: "2026-10-20",
    due_time: "10:00:00",
    duration: "00:30:00",
    owner_id: 5,
    note: "<p>Human prepared agenda</p>",
    ...overrides,
  });

  it("creates activities with the agent prefix and marker note, and reuses an identical one", async () => {
    const api = mockApi({
      "GET /api/v2/activities": EMPTY_LIST,
      "POST /api/v2/activities": { success: true, data: { id: 71 } },
    });
    const outcome = expectApplied(
      await client().createActivity({ requested_by: "Éric", subject: "Follow up", type: "call", deal_id: 9, due_date: "2026-10-21", due_time: "09:30", note: "Ask about <budget>" }),
    );
    expect(api.to("POST /api/v2/activities")[0].body).toEqual({
      subject: "[Agent] Follow up",
      type: "call",
      note: "<p>[Agent-made for Éric]</p><p>Ask about &lt;budget&gt;</p>",
      deal_id: 9,
      due_date: "2026-10-21",
      due_time: "09:30",
    });
    expect(api.to("GET /api/v2/activities")[0].query.get("deal_id")).toBe("9");
    expect(outcome.trace_status).toBe("not_required");

    const reuse = mockApi({
      "GET /api/v2/activities": { data: [rawActivity({ id: 80, subject: "[Agent] Follow up", due_date: "2026-10-21", due_time: "09:30" })], additional_data: {} },
      "POST /api/v2/activities": { success: true, data: { id: 71 } },
    });
    const again = await client().createActivity({ requested_by: "Éric", subject: "follow up", type: "call", deal_id: 9, due_date: "2026-10-21", due_time: "09:30" });
    expect(again).toMatchObject({ status: "reused", id: 80 });
    expect(reuse.to("POST /api/v2/activities")).toHaveLength(0);
  });

  it("links a person as the primary participant because v2 person_id is read-only", async () => {
    const api = mockApi({ "GET /api/v2/activities": EMPTY_LIST, "POST /api/v2/activities": { success: true, data: { id: 71 } } });
    await client().createActivity({ requested_by: "Éric", subject: "Intro call", type: "call", person_id: 11 });
    const [post] = api.to("POST /api/v2/activities");
    expect(post.body).toMatchObject({ participants: [{ person_id: 11, primary: true }] });
    expect(post.body).not.toHaveProperty("person_id");
    expect(api.to("GET /api/v2/activities")[0].query.get("person_id")).toBe("11");
  });

  describe("reuse requires equivalence on every requested target and field", () => {
    const existing = rawActivity({
      id: 80,
      subject: "[Agent] Follow up",
      deal_id: 9,
      person_id: 11,
      due_date: "2026-10-21",
      due_time: "09:30",
      duration: "00:30",
      note: "<p>[Agent-made for Éric]</p><p>Ask about budget</p>",
      done: false,
    });
    const wanted = { requested_by: "Éric", subject: "Follow up", type: "call", deal_id: 9, due_date: "2026-10-21", due_time: "09:30" };
    const attempt = async (extra: Record<string, unknown>) => {
      const api = mockApi({ "GET /api/v2/activities": { data: [existing], additional_data: {} }, "POST /api/v2/activities": { success: true, data: { id: 81 } } });
      const outcome = await client().createActivity({ ...wanted, ...extra });
      return { outcome, posts: api.to("POST /api/v2/activities") };
    };

    it("reuses when every supplied target and field matches", async () => {
      const { outcome, posts } = await attempt({ person_id: 11, duration: "00:30", note: "Ask about budget", done: false });
      expect(outcome).toMatchObject({ status: "reused", id: 80 });
      expect(posts).toHaveLength(0);
    });

    it.each([
      ["a different person on the same deal", { person_id: 12 }],
      ["a different organization", { org_id: 5 }],
      ["a requested completion", { done: true }],
      ["a different duration", { duration: "01:00" }],
      ["a different note", { note: "Something else" }],
    ])("creates a new activity for %s", async (_name, extra) => {
      const { outcome, posts } = await attempt(extra);
      expect(outcome.status).toBe("applied");
      expect(posts).toHaveLength(1);
    });
  });

  it("needs a target and, for an explicit owner, hard confirmation before any I/O", async () => {
    const api = mockApi({});
    await expect(client().createActivity({ requested_by: "Éric", subject: "x", type: "call" })).rejects.toThrow(/at least one of lead_id/);
    await expect(client().createActivity({ requested_by: "Éric", subject: "x", type: "call", deal_id: 1, owner_id: 6 })).rejects.toThrow(/confirmed: true/);
    await expect(
      client().updateActivity({ requested_by: "Éric", id: 70, changes: { owner_id: 6 }, expected_before: { owner_id: 5 } }),
    ).rejects.toThrow(/confirmed: true/);
    expect(api.calls).toHaveLength(0);
  });

  it("completes an activity without confirmation, keeping the human note and exactly one marker", async () => {
    const api = mockApi({
      "GET /api/v2/activities/70": { success: true, data: rawActivity({ note: "<p>[Agent-made for Sam]</p><p>Human prepared agenda</p>" }) },
      "PATCH /api/v2/activities/70": { success: true, data: { id: 70 } },
    });
    const outcome = expectApplied(
      await client().updateActivity({ requested_by: "Éric", id: 70, changes: { done: true }, expected_before: { done: false } }),
    );
    const body = api.to("PATCH /api/v2/activities/70")[0].body as { done: boolean; note: string };
    expect(body.done).toBe(true);
    expect(body.note.match(/\[Agent-made for/g)).toHaveLength(1);
    expect(body.note).toContain("[Agent-made for Éric]");
    expect(body.note).toContain("<p>Human prepared agenda</p>");
    expect(body.note).toMatch(/Agent update for Éric \(.*\): Done false → true/);
    expect(Object.keys(body).sort()).toEqual(["done", "note"]);
    expect(outcome.trace_status).toBe("not_required");
  });

  describe("note change compares requested plaintext with the stored HTML", () => {
    const attempt = async (storedNote: string, note: string) => {
      const api = mockApi({
        "GET /api/v2/activities/70": { success: true, data: rawActivity({ note: storedNote }) },
        "PATCH /api/v2/activities/70": { success: true, data: { id: 70 } },
      });
      const outcome = await client().updateActivity({ requested_by: "Éric", id: 70, changes: { note }, expected_before: { note: storedNote } });
      return { outcome, patches: api.to("PATCH /api/v2/activities/70") };
    };

    it.each([
      ["&quot;", '<p>"</p>'],
      ["&#39;", "<p>'</p>"],
      ['"', "<p>&quot;</p>"],
    ])("applies note %s over stored %s instead of reporting unchanged", async (note, stored) => {
      const { outcome, patches } = await attempt(stored, note);
      expect(outcome).toMatchObject({ status: "applied" });
      expect(patches).toHaveLength(1);
    });

    it.each([
      ['"', '<p>"</p>'],
      ["'", "<p>'</p>"],
      ["&", "<p>&</p>"],
      ["&quot;", "<p>&quot;</p>"],
      ["a & b <i>", "<p>[Agent-made for Sam]</p><p>a & b &lt;i&gt;</p>"],
    ])("reports unchanged for note %s already stored as %s", async (note, stored) => {
      const { outcome, patches } = await attempt(stored, note);
      expect(outcome).toMatchObject({ status: "unchanged" });
      expect(patches).toHaveLength(0);
    });
  });

  it("applies owner change with confirmation, prefixes a changed subject, and conflicts on stale values", async () => {
    const api = mockApi({
      "GET /api/v2/activities/70": { success: true, data: rawActivity() },
      "GET /api/v1/users": USERS,
      "PATCH /api/v2/activities/70": { success: true, data: { id: 70 } },
    });
    await client().updateActivity({
      requested_by: "Éric",
      confirmed: true,
      id: 70,
      changes: { owner_id: 6, subject: "Renamed", note: "New <note>" },
      expected_before: { owner_id: 5, subject: "Discovery call", note: "<p>Human prepared agenda</p>" },
    });
    const body = api.to("PATCH /api/v2/activities/70")[0].body as Record<string, string | number>;
    expect(body.owner_id).toBe(6);
    expect(body.subject).toBe("[Agent] Renamed");
    expect(String(body.note)).toContain("<p>New &lt;note&gt;</p>");
    expect(String(body.note)).not.toContain("Human prepared agenda</p><p>New");
    // Live sandbox: the update line used to embed the previous note's HTML (a second, escaped "[Agent-made for …]").
    expect(String(body.note)).toMatch(/Agent update for Éric \(.*\): .*Note edited/);
    expect(String(body.note).match(/\[Agent-made for/g)).toHaveLength(1);

    const stale = await client().updateActivity({ requested_by: "Éric", id: 70, changes: { done: true }, expected_before: { done: true } });
    expect(stale).toMatchObject({ status: "conflict", conflicts: [{ field: "done" }] });
    expect(api.to("PATCH /api/v2/activities/70")).toHaveLength(1);
  });
});

describe("lead conversion", () => {
  const rawLead = { id: LEAD_ID, title: "ACME inbound", person_id: 11, organization_id: 22, is_archived: false, update_time: "2026-10-01 10:00:00" };
  const convertPath = `/api/v2/leads/${LEAD_ID}/convert/deal`;
  const statusPath = `/api/v2/leads/${LEAD_ID}/convert/status/conv-1`;
  const params = { ...who, lead_id: LEAD_ID, stage_id: 4, expected_update_time: "2026-10-01 10:00:00" };
  const routes = (status: unknown, extra: Record<string, unknown> = {}) => ({
    [`GET /api/v1/leads/${LEAD_ID}`]: { success: true, data: rawLead },
    "GET /api/v2/stages/4": { data: { id: 4, pipeline_id: 1 } },
    "GET /api/v2/deals/search": EMPTY_SEARCH,
    [`POST ${convertPath}`]: { success: true, data: { conversion_id: "conv-1" } },
    [`GET ${statusPath}`]: status,
    "GET /api/v1/notes": EMPTY_LIST,
    "POST /api/v1/notes": NOTE_CREATED,
    ...extra,
  });

  it("converts, polls to completion and writes the Lead → Deal trace on the new deal", async () => {
    const api = mockApi(
      routes([
        { data: { status: "running" } },
        { data: { status: "completed", deal_id: 99, lead_id: LEAD_ID, conversion_id: "conv-1" } },
      ]),
    );
    const outcome = (await client().convertLeadToDeal({ ...params, pipeline_id: 1 })) as Extract<WriteOutcome, { conversion_id: string }>;
    expect(outcome).toMatchObject({ status: "converted", deal_id: 99, conversion_id: "conv-1", trace_status: "created" });
    expect(api.to(`POST ${convertPath}`)[0].body).toEqual({ stage_id: 4, pipeline_id: 1 });
    const trace = api.to("POST /api/v1/notes")[0];
    expect(trace.body).toMatchObject({ deal_id: 99 });
    expect(String(trace.body?.content)).toContain(`Lead ${LEAD_ID} → Deal 99`);
    expect(String(trace.body?.content)).toContain("conversion conv-1");
  });

  it("returns pending with the conversion id when polling budget ends and resume never POSTs again", async () => {
    const pending = mockApi(routes({ data: { status: "running" } }));
    const outcome = await client().convertLeadToDeal(params);
    expect(outcome).toMatchObject({ status: "pending", conversion_id: "conv-1", deal_id: null });
    expect(pending.to(`GET ${statusPath}`)).toHaveLength(5);
    expect(pending.to(`POST ${convertPath}`)).toHaveLength(1);
    expect(pending.to("POST /api/v1/notes")).toHaveLength(0);

    const resume = mockApi(routes({ data: { status: "completed", deal_id: 99 } }));
    const resumed = await client().convertLeadToDeal({ ...params, conversion_id: "conv-1" });
    expect(resumed).toMatchObject({ status: "converted", deal_id: 99 });
    expect(resume.to(`POST ${convertPath}`)).toHaveLength(0);
    expect(resume.to(`GET /api/v1/leads/${LEAD_ID}`)).toHaveLength(0);
  });

  it("deduplicates the completion trace by conversion id", async () => {
    const api = mockApi(
      routes(
        { data: { status: "completed", deal_id: 99 } },
        { "GET /api/v1/notes": { data: [{ id: 5, content: `<p>Lead ${LEAD_ID} → Deal 99: converted (conversion conv-1, 2026-10-01T10:00:00Z).</p>` }], additional_data: {} } },
      ),
    );
    const outcome = await client().convertLeadToDeal({ ...params, conversion_id: "conv-1" });
    expect(outcome).toMatchObject({ status: "converted", trace_status: "created" });
    expect(api.to("POST /api/v1/notes")).toHaveLength(0);
  });

  it("never posts a second trace when the duplicate-note lookup fails or is malformed, and hands over a repair", async () => {
    const lookups = [jsonResponse({ error: "boom" }, 400), { data: null }, jsonResponse({ error: "down" }, 503, { "retry-after": "0" })];
    for (const notes of lookups) {
      const api = mockApi(routes({ data: { status: "completed", deal_id: 99 } }, { "GET /api/v1/notes": notes }));
      const outcome = await client().convertLeadToDeal({ ...params, conversion_id: "conv-1" });
      expect(outcome).toMatchObject({ status: "converted", deal_id: 99, trace_status: "failed", partial_success: true, trace_repair: null });
      expect(outcome.message).toContain("conversion_id conv-1");
      expect(outcome.message).toContain("Do not use create_note");
      expect(api.to("POST /api/v1/notes")).toHaveLength(0);
      expect(api.to(`POST ${convertPath}`)).toHaveLength(0);
    }
  });

  it("resumes with the same conversion id after a failed lookup and adds no second trace when the first one already landed", async () => {
    const landed = { data: [{ id: 5, content: `<p>Lead ${LEAD_ID} → Deal 99: converted (conversion conv-1, 2026-10-01T10:00:00Z).</p>` }], additional_data: {} };
    const failedLookup = mockApi(routes({ data: { status: "completed", deal_id: 99 } }, { "GET /api/v1/notes": jsonResponse({ error: "boom" }, 400) }));
    const first = await client().convertLeadToDeal({ ...params, conversion_id: "conv-1" });
    expect(first).toMatchObject({ trace_status: "failed", trace_repair: null });
    expect(failedLookup.calls.filter((call) => call.method === "POST")).toHaveLength(0);

    const recovered = mockApi(routes({ data: { status: "completed", deal_id: 99 } }, { "GET /api/v1/notes": landed }));
    const resumed = await client().convertLeadToDeal({ ...params, conversion_id: "conv-1" });
    expect(resumed).toMatchObject({ status: "converted", trace_status: "created", partial_success: false });
    expect(recovered.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("returns a resumable pending result with the conversion id when status polling fails after the conversion was accepted", async () => {
    const failures: unknown[] = [
      () => {
        throw new TypeError("fetch failed");
      },
      jsonResponse({ error: "gone" }, 404),
      { data: {} },
    ];
    for (const status of failures) {
      const api = mockApi(routes(status));
      const outcome = await client().convertLeadToDeal(params);
      expect(outcome).toMatchObject({ status: "pending", conversion_id: "conv-1", conversion_status: "unknown", deal_id: null });
      expect(outcome.message).toContain("conversion_id conv-1");
      expect(outcome.message).toContain("will not re-send");
      expect(api.to(`POST ${convertPath}`)).toHaveLength(1);
      expect(api.to("POST /api/v1/notes")).toHaveLength(0);
    }
  });

  it("keeps failed distinct from pending and never reports it as converted", async () => {
    mockApi(routes({ data: { status: "failed" } }));
    const outcome = await client().convertLeadToDeal(params);
    expect(outcome).toMatchObject({ status: "failed", conversion_status: "failed", deal_id: null });
  });

  it("reports partial success when the conversion trace fails, without re-converting", async () => {
    const api = mockApi(routes({ data: { status: "completed", deal_id: 99 } }, { "POST /api/v1/notes": jsonResponse({}, 400) }));
    const outcome = await client().convertLeadToDeal(params);
    expect(outcome).toMatchObject({ status: "converted", trace_status: "failed", partial_success: true, trace_repair: { target: { deal_id: 99 } } });
    expect(api.to(`POST ${convertPath}`)).toHaveLength(1);
  });

  it("aborts on a stale lead, archived lead or an existing linked same-title deal, before POSTing", async () => {
    const stale = mockApi(routes({ data: { status: "completed", deal_id: 99 } }));
    const conflict = await client().convertLeadToDeal({ ...params, expected_update_time: "2026-09-01 00:00:00" });
    expect(conflict).toMatchObject({ status: "conflict", conflicts: [{ field: "update_time" }] });
    expect(stale.to(`POST ${convertPath}`)).toHaveLength(0);

    const archived = mockApi(routes({}, { [`GET /api/v1/leads/${LEAD_ID}`]: { data: { ...rawLead, is_archived: true } } }));
    await expect(client().convertLeadToDeal(params)).rejects.toThrow(/archived/);
    expect(archived.to(`POST ${convertPath}`)).toHaveLength(0);

    const duplicate = mockApi(
      routes({}, { "GET /api/v2/deals/search": { data: { items: [{ item: { id: 3, title: "acme inbound", status: "open", organization: { id: 22 } } }] }, additional_data: {} } }),
    );
    const blocked = await client().convertLeadToDeal(params);
    expect(blocked).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: 3 }] });
    expect(duplicate.to(`POST ${convertPath}`)).toHaveLength(0);
  });

  it("treats a missing conversion id as an unknown outcome instead of success", async () => {
    mockApi(routes({}, { [`POST ${convertPath}`]: { success: true, data: {} } }));
    await expect(client().convertLeadToDeal(params)).rejects.toBeInstanceOf(PipedriveOutcomeUnknownError);
  });
});

describe("lead labels", () => {
  const auditRoutes = {
    [`GET /api/v1/leads/${AUDIT_LEAD_ID}`]: { success: true, data: { id: AUDIT_LEAD_ID, title: "Audit" } },
    "POST /api/v1/notes": NOTE_CREATED,
  };

  it("creates a label and records a global-impact trace on the audit lead", async () => {
    const api = mockApi({
      ...auditRoutes,
      "GET /api/v1/leadLabels": { data: [{ id: LABEL_ID, name: "Hot", color: "red" }] },
      "POST /api/v1/leadLabels": { success: true, data: { id: "99999999-2222-4333-8444-555555555555" } },
    });
    const outcome = expectApplied(await client().createLeadLabel({ ...who, name: "Cold", color: "blue", audit_lead_id: AUDIT_LEAD_ID }));
    expect(api.to("POST /api/v1/leadLabels")[0].body).toEqual({ name: "Cold", color: "blue" });
    expect(api.to("POST /api/v1/notes")[0].body).toMatchObject({ lead_id: AUDIT_LEAD_ID });
    expect(String(api.to("POST /api/v1/notes")[0].body?.content)).toContain("global");
    expect(outcome.trace_status).toBe("created");
  });

  it("reuses an existing label with the same normalized name", async () => {
    const api = mockApi({ ...auditRoutes, "GET /api/v1/leadLabels": { data: [{ id: LABEL_ID, name: "Hot", color: "red" }] } });
    const outcome = await client().createLeadLabel({ ...who, name: " hot ", audit_lead_id: AUDIT_LEAD_ID });
    expect(outcome).toMatchObject({ status: "reused", id: LABEL_ID });
    expect(api.to("POST /api/v1/leadLabels")).toHaveLength(0);
  });

  it("renames via PATCH, warns about every lead, and traces on the audit lead", async () => {
    const api = mockApi({
      ...auditRoutes,
      "GET /api/v1/leadLabels": { data: [{ id: LABEL_ID, name: "Hot", color: "red" }] },
      [`PATCH /api/v1/leadLabels/${LABEL_ID}`]: { success: true, data: { id: LABEL_ID } },
    });
    await client().updateLeadLabel({ ...who, id: LABEL_ID, changes: { name: "Very hot" }, expected_before: { name: "Hot" }, audit_lead_id: AUDIT_LEAD_ID });
    expect(api.to(`PATCH /api/v1/leadLabels/${LABEL_ID}`)[0].body).toEqual({ name: "Very hot" });
    const trace = String(api.to("POST /api/v1/notes")[0].body?.content);
    expect(trace).toContain("Name Hot → Very hot");
    expect(trace).toContain("EVERY lead");
    expect(api.to("POST /api/v1/notes")[0].body).toMatchObject({ lead_id: AUDIT_LEAD_ID });
  });

  it("blocks label changes, with zero mutations, when the label list is malformed instead of reading it as empty", async () => {
    for (const labels of [{ data: null }, { data: {} }, { data: [{ name: "No id" }] }]) {
      const api = mockApi({ ...auditRoutes, "GET /api/v1/leadLabels": labels, "POST /api/v1/leadLabels": { success: true, data: { id: LABEL_ID } }, [`PATCH /api/v1/leadLabels/${LABEL_ID}`]: { success: true, data: { id: LABEL_ID } } });
      await expect(client().createLeadLabel({ ...who, name: "Cold", audit_lead_id: AUDIT_LEAD_ID })).rejects.toThrow(/creation is blocked/);
      await expect(
        client().updateLeadLabel({ ...who, id: LABEL_ID, changes: { name: "Cold" }, expected_before: { name: "Hot" }, audit_lead_id: AUDIT_LEAD_ID }),
      ).rejects.toThrow(/creation is blocked/);
      expect(api.to("POST /api/v1/leadLabels")).toHaveLength(0);
      expect(api.to(`PATCH /api/v1/leadLabels/${LABEL_ID}`)).toHaveLength(0);
      expect(api.to("POST /api/v1/notes")).toHaveLength(0);
    }
  });

  it("blocks renames onto an existing label and conflicts on stale definitions", async () => {
    const api = mockApi({
      ...auditRoutes,
      "GET /api/v1/leadLabels": { data: [{ id: LABEL_ID, name: "Hot", color: "red" }, { id: "other-id", name: "Cold", color: "blue" }] },
      [`PATCH /api/v1/leadLabels/${LABEL_ID}`]: { success: true, data: { id: LABEL_ID } },
    });
    const clash = await client().updateLeadLabel({ ...who, id: LABEL_ID, changes: { name: "cold" }, expected_before: { name: "Hot" }, audit_lead_id: AUDIT_LEAD_ID });
    expect(clash).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: "other-id" }] });
    const stale = await client().updateLeadLabel({ ...who, id: LABEL_ID, changes: { color: "green" }, expected_before: { color: "purple" }, audit_lead_id: AUDIT_LEAD_ID });
    expect(stale.status).toBe("conflict");
    expect(api.to(`PATCH /api/v1/leads/${LABEL_ID}`)).toHaveLength(0);
    expect(api.to(`PATCH /api/v1/leadLabels/${LABEL_ID}`)).toHaveLength(0);
  });
});

describe("preflight rows must carry the fields the comparison needs", () => {
  const searchOf = (item: Record<string, unknown>) => ({ data: { items: [{ item }] }, additional_data: {} });
  const listOf = (row: Record<string, unknown>) => ({ data: [row], additional_data: {} });
  const BLOCKED = /could not be completed/;

  it("blocks person, organization, deal and lead creation with zero mutations on a candidate with a wrong-typed id or no name/title", async () => {
    const cases: { label: string; routes: Record<string, unknown>; post: string; run: () => Promise<unknown> }[] = [
      {
        label: "person with string id",
        routes: { "GET /api/v2/persons/search": searchOf({ id: "12", name: "Jane Doe" }) },
        post: "POST /api/v2/persons",
        run: () => client().createPerson({ ...who, name: "Jane Doe" }),
      },
      {
        label: "person without name",
        routes: { "GET /api/v2/persons/search": searchOf({ id: 12 }) },
        post: "POST /api/v2/persons",
        run: () => client().createPerson({ ...who, name: "Jane Doe" }),
      },
      {
        label: "organization without name",
        routes: { "GET /api/v2/organizations/search": searchOf({ id: 12 }) },
        post: "POST /api/v2/organizations",
        run: () => client().createOrganization({ ...who, name: "Acme" }),
      },
      {
        label: "deal without title",
        routes: { "GET /api/v2/deals/search": searchOf({ id: 3 }) },
        post: "POST /api/v2/deals",
        run: () => client().createDeal({ ...who, title: "New deal" }),
      },
      {
        label: "lead search row without title",
        routes: { "GET /api/v2/leads/search": searchOf({ id: LEAD_ID }) },
        post: "POST /api/v1/leads",
        run: () => client().createLead({ ...who, title: "ACME inbound", person_id: 11 }),
      },
      {
        label: "linked lead row without title",
        routes: { "GET /api/v2/leads/search": EMPTY_SEARCH, "GET /api/v1/leads": listOf({ id: LEAD_ID }) },
        post: "POST /api/v1/leads",
        run: () => client().createLead({ ...who, title: "ACME inbound", person_id: 11 }),
      },
      {
        label: "activity row without subject",
        routes: { "GET /api/v2/activities": listOf({ id: 70, type: "call" }) },
        post: "POST /api/v2/activities",
        run: () => client().createActivity({ requested_by: "Éric", subject: "Follow up", type: "call", deal_id: 9 }),
      },
      {
        label: "note without content",
        routes: { "GET /api/v1/notes": listOf({ id: 5 }) },
        post: "POST /api/v1/notes",
        run: () => client().createNote({ requested_by: "Éric", lead_id: LEAD_ID, content: "hello" }),
      },
    ];
    for (const { label, routes, post, run } of cases) {
      const api = mockApi({
        ...routes,
        "GET /api/v1/users": USERS,
        [post]: { success: true, data: { id: 50 } },
        "POST /api/v1/notes": NOTE_CREATED,
      });
      await expect(run(), label).rejects.toThrow(BLOCKED);
      expect(api.calls.filter((call) => call.method !== "GET"), label).toHaveLength(0);
    }
  });

  it("does not post a second conversion trace when an existing note row has no content", async () => {
    const lead = { id: LEAD_ID, title: "ACME inbound", person_id: 11, update_time: "2026-10-01 10:00:00" };
    const api = mockApi({
      [`GET /api/v2/leads/${LEAD_ID}/convert/status/conv-1`]: { data: { status: "completed", deal_id: 99 } },
      "GET /api/v1/notes": listOf({ id: 5 }),
      "POST /api/v1/notes": NOTE_CREATED,
      [`GET /api/v1/leads/${LEAD_ID}`]: { data: lead },
    });
    const outcome = await client().convertLeadToDeal({ ...who, lead_id: LEAD_ID, stage_id: 4, expected_update_time: "2026-10-01 10:00:00", conversion_id: "conv-1" });
    expect(outcome).toMatchObject({ status: "converted", trace_status: "failed", partial_success: true });
    expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("includes a numeric SIREN custom field in the organization duplicate search and blocks creation on a different-name match", async () => {
    const KEY_SIREN = "9".repeat(40);
    const api = mockApi({
      "GET /api/v1/organizationFields": { data: [{ id: 9, key: KEY_SIREN, name: "SIREN", field_type: "double", edit_flag: true }], additional_data: NO_MORE },
      "GET /api/v2/organizations/search": (call: { query: URLSearchParams }) =>
        call.query.get("fields") === "custom_fields" ? searchOf({ id: 7, name: "Different Name SAS" }) : EMPTY_SEARCH,
      "POST /api/v2/organizations": { success: true, data: { id: 50 } },
      "POST /api/v1/notes": NOTE_CREATED,
    });
    const outcome = await client().createOrganization({ ...who, name: "Acme", custom_fields: { SIREN: 123456789 } });
    expect(outcome).toMatchObject({ status: "duplicate_candidates", candidates: [{ id: 7, matched_on: ["SIREN 123456789"] }] });
    const custom = api.to("GET /api/v2/organizations/search").find((call) => call.query.get("fields") === "custom_fields");
    expect(custom?.query.get("term")).toBe("123456789");
    expect(api.to("POST /api/v2/organizations")).toHaveLength(0);
  });
});
