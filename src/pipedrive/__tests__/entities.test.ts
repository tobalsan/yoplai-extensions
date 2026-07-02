import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PipedriveClient,
  parseAddress,
  parseContactDetails,
  primaryValue,
} from "../client.js";
import { PipedriveNotFoundError } from "../errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient(): PipedriveClient {
  return new PipedriveClient({ apiToken: "secret-token", domain: "acme", timeoutMs: 1_000 });
}

function url(spy: ReturnType<typeof vi.spyOn>, call = 0): URL {
  return new URL(String((spy.mock.calls[call] as unknown[])?.[0]));
}

const rawOrg = {
  id: 679,
  name: "ATLAS COPCO",
  address: {
    value: "Stockholm, Sweden",
    locality: "Stockholm",
    admin_area_level_1: "Stockholm County",
    country: "Sweden",
    postal_code: "",
    formatted_address: "Stockholm, Sweden",
  },
  custom_fields: {},
};

const rawPerson = {
  id: 1609,
  name: "Kristof Heselmans",
  first_name: "Kristof",
  last_name: "Heselmans",
  org_id: 10282,
  job_title: null,
  phones: [],
  emails: [
    { label: "work", value: "kristof.heselmans@atlascopco.com", primary: true },
  ],
};

describe("PipedriveClient.getOrganization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves an org_id to name + structured address on the v2 endpoint", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      // organizations/:id, then organizationFields (no VAT/SIREN configured)
      .mockResolvedValueOnce(jsonResponse({ data: rawOrg }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const org = await createClient().getOrganization(679);

    const u = url(spy);
    expect(u.pathname).toBe("/api/v2/organizations/679");
    expect(u.searchParams.get("api_token")).toBe("secret-token");
    expect(org.id).toBe(679);
    expect(org.name).toBe("ATLAS COPCO");
    expect(org.address?.formatted_address).toBe("Stockholm, Sweden");
    expect(org.address?.locality).toBe("Stockholm");
    expect(org.address?.country).toBe("Sweden");
    // Empty parts normalize to null.
    expect(org.address?.postal_code).toBeNull();
    expect(org.vat).toBeNull();
    expect(org.siren).toBeNull();
    expect(org.org_url).toBe("https://acme.pipedrive.com/organization/679");
  });

  it("resolves VAT/SIREN from custom fields when the org has those fields", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...rawOrg,
            custom_fields: { vatkey123: "FR12345678901", sirenkey456: "552100554" },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { key: "vatkey123", name: "VAT Number" },
            { key: "sirenkey456", name: "SIREN" },
          ],
        }),
      );

    const org = await createClient().getOrganization(679);

    expect(org.vat).toBe("FR12345678901");
    expect(org.siren).toBe("552100554");
  });

  it("returns a null address when the org has no address", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { id: 5, name: "No Address Co", address: null } }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const org = await createClient().getOrganization(5);
    expect(org.address).toBeNull();
  });

  it("throws PipedriveNotFoundError when the org is missing (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(createClient().getOrganization(999)).rejects.toBeInstanceOf(PipedriveNotFoundError);
  });

  it("throws PipedriveNotFoundError when the payload has no org data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: null }));
    await expect(createClient().getOrganization(999)).rejects.toBeInstanceOf(PipedriveNotFoundError);
  });
});

describe("PipedriveClient.getPerson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a person_id to name + contact details on the v2 endpoint", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: rawPerson }));

    const person = await createClient().getPerson(1609);

    expect(url(spy).pathname).toBe("/api/v2/persons/1609");
    expect(person.id).toBe(1609);
    expect(person.name).toBe("Kristof Heselmans");
    expect(person.first_name).toBe("Kristof");
    expect(person.org_id).toBe(10282);
    expect(person.job_title).toBeNull();
    expect(person.emails).toEqual([
      { label: "work", value: "kristof.heselmans@atlascopco.com", primary: true },
    ]);
    expect(person.phones).toEqual([]);
    expect(person.primary_email).toBe("kristof.heselmans@atlascopco.com");
    expect(person.primary_phone).toBeNull();
    expect(person.person_url).toBe("https://acme.pipedrive.com/person/1609");
  });

  it("throws PipedriveNotFoundError when the person is missing (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(createClient().getPerson(999)).rejects.toBeInstanceOf(PipedriveNotFoundError);
  });

  it("throws PipedriveNotFoundError when the payload has no person data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: null }));
    await expect(createClient().getPerson(999)).rejects.toBeInstanceOf(PipedriveNotFoundError);
  });
});

describe("entity parsing helpers", () => {
  it("parseAddress returns null for a non-object or all-empty address", () => {
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress("Stockholm")).toBeNull();
    expect(parseAddress({ locality: "", country: "" })).toBeNull();
  });

  it("parseContactDetails drops entries with no value and flags primary", () => {
    const details = parseContactDetails([
      { label: "work", value: "a@x.com", primary: true },
      { label: "home", value: "", primary: false },
      { value: "b@x.com" },
    ]);
    expect(details).toEqual([
      { label: "work", value: "a@x.com", primary: true },
      { label: null, value: "b@x.com", primary: false },
    ]);
  });

  it("primaryValue prefers the primary entry, else the first, else null", () => {
    expect(primaryValue([])).toBeNull();
    expect(
      primaryValue([
        { label: null, value: "first", primary: false },
        { label: null, value: "second", primary: true },
      ]),
    ).toBe("second");
    expect(primaryValue([{ label: null, value: "only", primary: false }])).toBe("only");
  });
});
