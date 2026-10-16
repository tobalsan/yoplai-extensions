import { describe, expect, it } from "vitest";

import { PipedriveError, PipedriveNotFoundError } from "../errors.js";
import { KEY_VAT, NO_MORE, ORGANIZATION_FIELDS, mockApi, useWriteClient } from "./write-helpers.js";

const { client } = useWriteClient();

describe("supporting reads for write workflows", () => {
  it("searches persons (v2) with filters and a lean projection", async () => {
    const api = mockApi({
      "GET /api/v2/persons/search": {
        data: {
          items: [
            { result_score: 0.9, item: { id: 5, name: "Jane Doe", emails: ["jane@acme.test"], phones: ["+33123"], organization: { id: 22, name: "Acme" } } },
          ],
        },
        additional_data: { next_cursor: "c2" },
      },
    });
    const result = await client(false).searchPersons({ term: "jane", fields: "email", exact_match: true, organization_id: 22, limit: 10 });
    const query = api.calls[0].query;
    expect(Object.fromEntries(query)).toMatchObject({ term: "jane", fields: "email", exact_match: "true", organization_id: "22", limit: "10" });
    expect(result).toEqual({
      persons: [
        { id: 5, name: "Jane Doe", emails: ["jane@acme.test"], phones: ["+33123"], org_id: 22, org_name: "Acme", result_score: 0.9, person_url: "https://acme.pipedrive.com/person/5" },
      ],
      next_cursor: "c2",
      count: 1,
    });
  });

  it("searches organizations (v2)", async () => {
    mockApi({
      "GET /api/v2/organizations/search": { data: { items: [{ result_score: 1, item: { id: 8, name: "Acme SAS", address: "1 rue X" } }] }, additional_data: {} },
    });
    expect(await client(false).searchOrganizations({ term: "acme" })).toEqual({
      organizations: [{ id: 8, name: "Acme SAS", address: "1 rue X", result_score: 1, org_url: "https://acme.pipedrive.com/organization/8" }],
      next_cursor: null,
      count: 1,
    });
  });

  it("lists person and organization field definitions via the v1 endpoints", async () => {
    const api = mockApi({ "GET /api/v1/organizationFields": ORGANIZATION_FIELDS, "GET /api/v1/personFields": { data: [], additional_data: NO_MORE } });
    const result = await client(false).listContactFields({ entity: "organization", start: 0, limit: 50 });
    expect(result.fields.map((field) => field.key)).toEqual(["name", KEY_VAT]);
    await client(false).listContactFields({ entity: "person" });
    expect(api.calls.map((call) => call.path)).toEqual(["/api/v1/organizationFields", "/api/v1/personFields"]);
  });

  it("reads one activity (v2) and the activity types (v1)", async () => {
    mockApi({
      "GET /api/v2/activities/70": { data: { id: 70, subject: "Call", type: "call", done: false, owner_id: 5, lead_id: "l-1", person_id: 3, org_id: 4, duration: "00:30:00", note: "n" } },
      "GET /api/v2/activities/71": { data: {} },
      "GET /api/v1/activityTypes": { data: [{ id: 1, name: "Call", key_string: "call", active_flag: true }, { id: 2, name: "Bad" }] },
    });
    expect(await client(false).getActivity({ id: 70 })).toMatchObject({ id: 70, user_id: 5, lead_id: "l-1", person_id: 3, org_id: 4, duration: "00:30:00" });
    await expect(client(false).getActivity({ id: 71 })).rejects.toBeInstanceOf(PipedriveNotFoundError);
    expect(await client(false).listActivityTypes()).toEqual({ types: [{ id: 1, name: "Call", key_string: "call", active: true }], count: 1 });
  });
});

describe("get_person / get_organization output_type", () => {
  const rawPerson = { id: 5, name: "Jane", org_id: 22, owner_id: 5, add_time: "a", update_time: "u", emails: [{ value: "j@a.test", primary: true, label: "work" }], phones: [], custom_fields: { [KEY_VAT]: "FR1" } };

  it("preserves the original projection when output_type is omitted or lean", async () => {
    const api = mockApi({ "GET /api/v2/persons/5": { data: rawPerson } });
    const omitted = await client(false).getPerson(5);
    expect(omitted).not.toHaveProperty("owner_id");
    expect(omitted).not.toHaveProperty("normalized_extra_fields");
    expect(await client(false).getPerson(5, "lean")).toEqual(omitted);
    expect(api.calls.every((call) => call.path === "/api/v2/persons/5")).toBe(true);
  });

  it("full mode adds owner, timestamps and normalized custom fields", async () => {
    mockApi({ "GET /api/v2/persons/5": { data: rawPerson }, "GET /api/v1/personFields": ORGANIZATION_FIELDS });
    const full = await client(false).getPerson(5, "full");
    expect(full).toMatchObject({ owner_id: 5, add_time: "a", update_time: "u", normalized_extra_fields: { "VAT number": "FR1" } });
    expect(full.normalized_field_metadata).toEqual({ "VAT number": { key: KEY_VAT, type: "varchar" } });
  });

  it("full organization read keeps standard fields and adds metadata", async () => {
    mockApi({
      "GET /api/v2/organizations/22": { data: { id: 22, name: "Acme", owner_id: 6, update_time: "u", custom_fields: { [KEY_VAT]: "FR1" } } },
      "GET /api/v1/organizationFields": ORGANIZATION_FIELDS,
    });
    const full = await client(false).getOrganization(22, "full");
    expect(full).toMatchObject({ id: 22, name: "Acme", vat: "FR1", owner_id: 6, update_time: "u", normalized_extra_fields: { "VAT number": "FR1" } });
  });
});

describe("fetchAllFields", () => {
  it("follows offset pagination to completion", async () => {
    const api = mockApi({
      "GET /api/v1/personFields": (call: { query: URLSearchParams }) =>
        call.query.get("start") === "0"
          ? { data: [{ id: 1, key: "a", name: "A", field_type: "varchar" }], additional_data: { pagination: { start: 0, limit: 500, more_items_in_collection: true, next_start: 500 } } }
          : { data: [{ id: 2, key: "b", name: "B", field_type: "varchar" }], additional_data: NO_MORE },
    });
    const fields = await client(false).fetchAllFields("person");
    expect(fields.map((field) => field.key)).toEqual(["a", "b"]);
    expect(api.calls).toHaveLength(2);
  });

  it("fails closed on loops, malformed pages and the page safety bound", async () => {
    mockApi({ "GET /api/v1/dealFields": { data: [], additional_data: { pagination: { start: 0, limit: 500, more_items_in_collection: true, next_start: 0 } } } });
    await expect(client(false).fetchAllFields("deal")).rejects.toThrow(/did not advance/);

    mockApi({ "GET /api/v1/dealFields": { data: null } });
    await expect(client(false).fetchAllFields("deal")).rejects.toBeInstanceOf(PipedriveError);

    let next = 0;
    mockApi({
      "GET /api/v1/dealFields": () => ({ data: [], additional_data: { pagination: { start: next, limit: 500, more_items_in_collection: true, next_start: (next += 500) } } }),
    });
    await expect(client(false).fetchAllFields("deal")).rejects.toThrow(/exceeded 20 pages/);
  });
});
