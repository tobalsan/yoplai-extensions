import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "../index.js";

function tool(name: string) {
  return extension.createTools({
    global: {}, agent: {}, merged: { apiToken: "test-token", domain: "acme" },
  }).find((entry) => entry.name === name)!;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("deal filters through tool execution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("searches all non-deleted deals without sending a status filter", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { items: [] } }));

    const result = await tool("search_deals").execute({ term: "Renewal", status: "all" });

    expect(result).toEqual({ deals: [], count: 0, next_cursor: null });
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.has("status")).toBe(false);
  });

  it("accepts the legacy all_not_deleted search filter without forwarding it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { items: [] } }));

    await tool("search_deals").execute({ term: "Renewal", status: "all_not_deleted" });

    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.has("status")).toBe(false);
  });

  it.each([undefined, "open", "won", "lost"])("searches with status %s", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { items: [] } }));

    await tool("search_deals").execute({ term: "Renewal", status });

    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("status")).toBe(status ?? null);
  });

  it("rejects deleted search status before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));

    await expect(tool("search_deals").execute({ term: "Renewal", status: "deleted" })).rejects.toThrow("status");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists all non-deleted deals without sending a status filter", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));

    const result = await tool("list_deals").execute({ status: "all" });

    expect(result).toEqual({ deals: [], count: 0, next_cursor: null });
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.has("status")).toBe(false);
  });

  it("accepts the legacy all_not_deleted list filter without forwarding it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));

    await tool("list_deals").execute({ status: "all_not_deleted" });

    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.has("status")).toBe(false);
  });

  it.each([[undefined, "open"], ["deleted", "deleted"]])("lists with status %s", async (status, expected) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));

    await tool("list_deals").execute({ status });

    const query = new URL(String(fetch.mock.calls[0]![0])).searchParams;
    expect(query.get("status")).toBe(expected);
    expect(query.get("sort_by")).toBe("update_time");
  });

  it("rejects an unsupported sort field before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));

    await expect(tool("list_deals").execute({ sort_by: "title" })).rejects.toThrow("sort_by");

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["asc", [3, 1, 2]],
    ["desc", [1, 3, 2]],
  ])("sorts the returned page by won_time %s with nulls last", async (direction, ids) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users")) return json({ data: [] });
      return json({ data: [
        { id: 1, title: "Later", won_time: "2026-10-20 12:00:00" },
        { id: 2, title: "Open", won_time: null },
        { id: 3, title: "Earlier", won_time: "2026-10-02 12:00:00" },
      ], additional_data: { next_cursor: "next-page" } });
    });

    const result = await tool("list_deals").execute({ sort_by: "won_time", sort_direction: direction });

    expect(result).toMatchObject({ deals: ids.map((id) => ({ id })), count: 3, next_cursor: "next-page" });
    const query = new URL(String(fetch.mock.calls.find(([input]) => String(input).includes("/v2/deals?"))![0])).searchParams;
    expect(query.get("sort_by")).toBe("id");
    expect(query.get("sort_direction")).toBe(direction);
  });

  it("sorts all won-date matches across joined pages without truncating or moving the cursor", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users")) return json({ data: [] });
      if (url.searchParams.get("cursor") === "page-two") {
        return json({ data: [
          { id: 3, title: "First won", won_time: "2026-10-01 12:00:00" },
          { id: 4, title: "Middle won", won_time: "2026-10-15 12:00:00" },
        ], additional_data: { next_cursor: "page-three" } });
      }
      return json({ data: [
        { id: 1, title: "Last won", won_time: "2026-10-25 12:00:00" },
        { id: 2, title: "Outside range", won_time: "2026-09-30 12:00:00" },
      ], additional_data: { next_cursor: "page-two" } });
    });
    const params = { status: "won", won_from: "2026-10-01", won_to: "2026-10-31", limit: 2, sort_direction: "asc" };

    const sorted = await tool("list_deals").execute({ ...params, sort_by: "won_time" });
    const native = await tool("list_deals").execute({ ...params, sort_by: "id" });

    expect(sorted).toMatchObject({ deals: [{ id: 3 }, { id: 4 }, { id: 1 }], count: 3, next_cursor: "page-three" });
    expect(native).toMatchObject({ deals: [{ id: 1 }, { id: 3 }, { id: 4 }], count: 3, next_cursor: "page-three" });
    const dealRequests = fetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname.endsWith("/deals"));
    expect(dealRequests).toHaveLength(4);
    for (const request of dealRequests) {
      expect(request.searchParams.get("sort_by")).toBe("id");
      expect(request.searchParams.get("sort_direction")).toBe("asc");
    }
  });
});
