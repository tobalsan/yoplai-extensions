import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipedriveClient } from "../client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function url(spy: ReturnType<typeof vi.spyOn>, call = 0): URL {
  return new URL(String((spy.mock.calls[call] as unknown[])?.[0]));
}

function rawLead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "adf21080-0e10-11eb-879b-05d71fb426ec",
    title: "Jane Doe lead",
    owner_id: 1,
    creator_id: 1,
    label_ids: ["6c00d2d8-4276-4437-9024-6dc23c6f2fda"],
    person_id: 1101,
    organization_id: null,
    source_name: "API",
    origin: "manual",
    origin_id: null,
    channel: 52,
    channel_id: null,
    is_archived: false,
    was_seen: true,
    value: { amount: 999, currency: "USD" },
    expected_close_date: "2026-09-30",
    next_activity_id: 8,
    add_time: "2026-09-01T10:00:00Z",
    update_time: "2026-09-10T10:00:00Z",
    visible_to: "3",
    cc_email: "acme@pipedrivemail.com",
    ...overrides,
  };
}

describe("PipedriveClient.listLeads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /leads and defaults archived_status to not_archived", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [rawLead()], additional_data: {} }));

    await createClient().listLeads({});

    const u = url(spy);
    expect(u.pathname).toBe("/api/v1/leads");
    expect(u.searchParams.get("archived_status")).toBe("not_archived");
    expect(u.searchParams.get("start")).toBe("0");
    expect(u.searchParams.get("limit")).toBe("100");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
  });

  it("applies server-side filters", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [], additional_data: {} }));

    await createClient().listLeads({
      archived_status: "all",
      owner_id: 1,
      person_id: 1101,
      organization_id: 5,
      filter_id: 9,
      sort: "update_time DESC",
    });

    const q = url(spy).searchParams;
    expect(q.get("archived_status")).toBe("all");
    expect(q.get("owner_id")).toBe("1");
    expect(q.get("person_id")).toBe("1101");
    expect(q.get("organization_id")).toBe("5");
    expect(q.get("filter_id")).toBe("9");
    expect(q.get("sort")).toBe("update_time DESC");
  });

  it("returns a lean projection with a constructed lead_url and translates start-cursor pagination", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [rawLead()],
          additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } },
        }),
      ),
    );

    const result = await createClient().listLeads({});

    expect(result.count).toBe(1);
    expect(result.next_cursor).toBe("100");
    expect(result.leads[0]).toEqual({
      id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      title: "Jane Doe lead",
      owner_id: 1,
      creator_id: 1,
      label_ids: ["6c00d2d8-4276-4437-9024-6dc23c6f2fda"],
      person_id: 1101,
      organization_id: null,
      source_name: "API",
      origin: "manual",
      origin_id: null,
      channel: 52,
      channel_id: null,
      is_archived: false,
      was_seen: true,
      value: { amount: 999, currency: "USD" },
      expected_close_date: "2026-09-30",
      next_activity_id: 8,
      add_time: "2026-09-01T10:00:00Z",
      update_time: "2026-09-10T10:00:00Z",
      visible_to: "3",
      cc_email: "acme@pipedrivemail.com",
      lead_url: "https://acme.pipedrive.com/leads/inbox/adf21080-0e10-11eb-879b-05d71fb426ec",
    });

    await createClient().listLeads({ cursor: result.next_cursor! });
    expect(url(spy, 1).searchParams.get("start")).toBe("100");
  });
});

describe("PipedriveClient.getLead", () => {
  let dir: string;
  let cachePath: string;

  function createLeadClient(): PipedriveClient {
    return new PipedriveClient({
      apiToken: "secret-token",
      domain: "acme",
      timeoutMs: 1_000,
      registryOptions: { cachePath },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pd-getlead-"));
    cachePath = path.join(dir, "registry.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const leadBody = {
    success: true,
    data: rawLead({ hashP: 26 }),
  };

  const fieldsBody = {
    success: true,
    data: [
      { id: 1, key: "hashP", name: "Priority", field_type: "enum", options: [{ id: 26, label: "High" }] },
    ],
    additional_data: {
      pagination: { start: 0, limit: 500, more_items_in_collection: false, next_start: null },
    },
  };

  it("full mode returns standard fields, lead URL, and normalized custom fields resolved via the deal-field schema", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/leads/adf21080-0e10-11eb-879b-05d71fb426ec")) return jsonResponse(leadBody);
      if (u.includes("/dealFields")) return jsonResponse(fieldsBody);
      throw new Error(`unexpected url ${u}`);
    });

    const detail = await createLeadClient().getLead({ id: "adf21080-0e10-11eb-879b-05d71fb426ec" });

    expect(url(spy).pathname).toBe("/api/v1/leads/adf21080-0e10-11eb-879b-05d71fb426ec");
    expect(detail).toMatchObject({
      id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      title: "Jane Doe lead",
      owner_id: 1,
      person_id: 1101,
      value: { amount: 999, currency: "USD" },
      lead_url: "https://acme.pipedrive.com/leads/inbox/adf21080-0e10-11eb-879b-05d71fb426ec",
    });
    expect(detail.normalized_extra_fields).toEqual({ Priority: "High" });
    expect(detail.normalized_field_metadata?.Priority).toEqual({ key: "hashP", type: "enum" });
  });

  it("full mode returns no resolved custom fields when the field schema fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/leads/adf21080-0e10-11eb-879b-05d71fb426ec")) return jsonResponse(leadBody);
      return jsonResponse({ success: false, error: "nope" }, 404);
    });

    const detail = await createLeadClient().getLead({ id: "adf21080-0e10-11eb-879b-05d71fb426ec" });

    expect(detail.title).toBe("Jane Doe lead");
    expect(detail.normalized_extra_fields).toEqual({});
  });

  it("lean mode strips normalized fields and never fetches the field schema", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/leads/adf21080-0e10-11eb-879b-05d71fb426ec")) return jsonResponse(leadBody);
      throw new Error(`unexpected url ${u}`);
    });

    const detail = await createLeadClient().getLead({
      id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      output_type: "lean",
    });

    expect(detail.normalized_extra_fields).toBeUndefined();
    expect(detail.normalized_field_metadata).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

function leadSearchItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result_score: 0.8,
    item: {
      id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      title: "Jane Doe lead",
      owner: { id: 1, name: "Eric" },
      person: { id: 1101, name: "Jane Doe" },
      organization: null,
      is_archived: false,
      value: { amount: 999, currency: "USD" },
      expected_close_date: "2026-09-30",
      ...overrides,
    },
  };
}

describe("PipedriveClient.searchLeads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /leads/search with the term and optional fields/filters", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { items: [] }, additional_data: {} }));

    await createClient().searchLeads({
      term: "jane",
      fields: "title,notes",
      exact_match: true,
      person_id: 1101,
      organization_id: 5,
      include_fields: "lead.was_seen",
    });

    const q = url(spy).searchParams;
    expect(url(spy).pathname).toBe("/api/v1/leads/search");
    expect(q.get("term")).toBe("jane");
    expect(q.get("fields")).toBe("title,notes");
    expect(q.get("exact_match")).toBe("true");
    expect(q.get("person_id")).toBe("1101");
    expect(q.get("organization_id")).toBe("5");
    expect(q.get("include_fields")).toBe("lead.was_seen");
    expect(q.get("api_token")).toBe("secret-token");
  });

  it("returns a lean match projection with owner/person/organization refs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: { items: [leadSearchItem()] },
        additional_data: { pagination: { more_items_in_collection: false } },
      }),
    );

    const result = await createClient().searchLeads({ term: "jane" });

    expect(result.count).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.leads[0]).toEqual({
      id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      title: "Jane Doe lead",
      owner: { id: 1, name: "Eric" },
      person: { id: 1101, name: "Jane Doe" },
      organization: null,
      is_archived: false,
      value: { amount: 999, currency: "USD" },
      currency: "USD",
      expected_close_date: "2026-09-30",
      result_score: 0.8,
    });
  });
});

describe("PipedriveClient.listLeadLabels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /leadLabels with no pagination", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "6c00d2d8-4276-4437-9024-6dc23c6f2fda",
            name: "Hot",
            color: "red",
            add_time: "2026-01-01T00:00:00Z",
            update_time: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );

    const result = await createClient().listLeadLabels();

    expect(url(spy).pathname).toBe("/api/v1/leadLabels");
    expect(result).toEqual({
      labels: [
        {
          id: "6c00d2d8-4276-4437-9024-6dc23c6f2fda",
          name: "Hot",
          color: "red",
          add_time: "2026-01-01T00:00:00Z",
          update_time: "2026-01-01T00:00:00Z",
        },
      ],
      count: 1,
    });
  });
});

describe("PipedriveClient.listLeadSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /leadSources with no pagination", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [{ name: "API" }, { name: "Manually created" }] }));

    const result = await createClient().listLeadSources();

    expect(url(spy).pathname).toBe("/api/v1/leadSources");
    expect(result).toEqual({ sources: [{ name: "API" }, { name: "Manually created" }], count: 2 });
  });
});

describe("PipedriveClient.listLeadNotes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v1 /notes filtered by lead_id", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 501,
            deal_id: null,
            lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
            content: "Called, left voicemail",
            user_id: 1,
            person_id: 1101,
            org_id: null,
            add_time: "2026-09-05T10:00:00Z",
            update_time: "2026-09-05T10:00:00Z",
            user: { name: "Eric" },
          },
        ],
        additional_data: { pagination: { more_items_in_collection: false } },
      }),
    );

    const result = await createClient().listLeadNotes({
      lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
    });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v1/notes");
    expect(u.searchParams.get("lead_id")).toBe("adf21080-0e10-11eb-879b-05d71fb426ec");
    expect(u.searchParams.has("deal_id")).toBe(false);
    expect(result.notes[0]).toEqual({
      id: 501,
      deal_id: null,
      lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      content: "Called, left voicemail",
      user_id: 1,
      user_name: "Eric",
      person_id: 1101,
      org_id: null,
      add_time: "2026-09-05T10:00:00Z",
      update_time: "2026-09-05T10:00:00Z",
    });
    expect(result.count).toBe(1);
  });
});

describe("PipedriveClient.listLeadActivities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("targets v2 /activities with lead_id and maps owner_id to user_id", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 900,
            lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
            deal_id: null,
            owner_id: 1,
            subject: "Follow up call",
            type: "call",
            done: true,
            due_date: "2026-09-10",
            due_time: "10:00:00",
            marked_as_done_time: "2026-09-10T10:05:00Z",
            note: null,
            add_time: "2026-09-09T09:00:00Z",
            update_time: "2026-09-10T10:05:00Z",
          },
        ],
        additional_data: { next_cursor: "eyJzdGFydCI6NX0" },
      }),
    );

    const result = await createClient().listLeadActivities({
      lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      done: true,
    });

    const u = url(spy);
    expect(u.pathname).toBe("/api/v2/activities");
    expect(u.searchParams.get("lead_id")).toBe("adf21080-0e10-11eb-879b-05d71fb426ec");
    expect(u.searchParams.get("done")).toBe("true");
    expect(result.next_cursor).toBe("eyJzdGFydCI6NX0");
    expect(result.activities[0]).toEqual({
      id: 900,
      deal_id: null,
      type: "call",
      subject: "Follow up call",
      note: null,
      done: true,
      due_date: "2026-09-10",
      due_time: "10:00:00",
      marked_as_done_time: "2026-09-10T10:05:00Z",
      user_id: 1,
      add_time: "2026-09-09T09:00:00Z",
      update_time: "2026-09-10T10:05:00Z",
    });
  });

  it("maps done: false to the v2 string 'false'", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [], additional_data: {} }));

    await createClient().listLeadActivities({
      lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec",
      done: false,
    });

    expect(url(spy).searchParams.get("done")).toBe("false");
  });
});

function createClient(): PipedriveClient {
  return new PipedriveClient({ apiToken: "secret-token", domain: "acme", timeoutMs: 1_000 });
}
