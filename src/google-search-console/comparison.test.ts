import { describe, expect, it } from "vitest";
import { comparePeriods, type ComparisonOptions } from "./comparison.js";

describe("Search Console period comparison", () => {
  it("defaults to 28 complete Pacific days and an adjacent equal period", async () => {
    const result = await comparePeriods({ siteUrl: "sc-domain:example.com" }, async () => ({ rows: [] }), new Date("2026-10-28T01:00:00Z"));
    expect(result.meta.current).toEqual({ startDate: "2026-09-27", endDate: "2026-10-24" });
    expect(result.meta.previous).toEqual({ startDate: "2026-08-30", endDate: "2026-09-26" });
    expect(result.meta).toMatchObject({ timezone: "America/Los_Angeles", rowsFetched: { current: 0, previous: 0 }, rowsMatched: 0, rowsReturned: 0, truncated: false, warnings: [] });
    expect(result.rows).toEqual([]);
  });
});

it("joins pages, identifies launches and disappearances, and computes exact deltas", async () => {
  const result = await comparePeriods({ siteUrl: "https://example.com/", current: { startDate: "2026-10-01", endDate: "2026-10-02" } }, async ({ startDate }) => ({ rows: startDate === "2026-10-01" ? [
    { keys: ["https://example.com/blog/article"], clicks: 5, impressions: 100, ctr: 0.05, position: 8 },
    { keys: ["https://example.com/new"], clicks: 3, impressions: 20, ctr: 0.15, position: 4 },
  ] : [
    { keys: ["https://example.com/blog/article"], clicks: 10, impressions: 200, ctr: 0.05, position: 5 },
    { keys: ["https://example.com/lost"], clicks: 2, impressions: 10, ctr: 0.2, position: 3 },
  ] }));
  expect(result.rows[0]).toEqual({ page: "https://example.com/blog/article", folder: "blog", current: { clicks: 5, impressions: 100, ctr: 0.05, position: 8 }, previous: { clicks: 10, impressions: 200, ctr: 0.05, position: 5 }, clicksDelta: -5, impressionsDelta: -100, ctrDelta: 0, positionDelta: 3, clicksPercentDelta: -50, impressionsPercentDelta: -50, ctrPercentDelta: 0, positionPercentDelta: 60, status: "both" });
  expect(result.rows.find(row => row.status === "new")).toMatchObject({ page: "https://example.com/new", folder: "new", clicksPercentDelta: null, positionDelta: null, previous: { clicks: 0, impressions: 0, ctr: 0, position: null } });
  expect(result.rows.find(row => row.status === "lost")).toMatchObject({ current: { clicks: 0, impressions: 0, ctr: 0, position: null }, clicksDelta: -2, clicksPercentDelta: -100, positionPercentDelta: null });
});

it("normalizes page URLs and merges duplicates with impression-weighted position and CTR", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" } }, async ({ startDate }) => ({ rows: startDate === "2026-10-01" ? [
    { keys: ["https://example.com/features/Portal/#heading"], clicks: 2, impressions: 10, ctr: 0.2, position: 2 },
    { keys: ["https://example.com/features/Portal"], clicks: 8, impressions: 90, ctr: 8 / 90, position: 12 },
    { keys: ["https://example.com/#intro"], clicks: 1, impressions: 4, ctr: 0.25, position: 1 },
  ] : [{ keys: ["https://example.com/features/Portal/"], clicks: 20, impressions: 100, ctr: 0.2, position: 6 }] }));
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({ page: "https://example.com/features/Portal", folder: "features", status: "both", current: { clicks: 10, impressions: 100, ctr: 0.1, position: 11 }, positionDelta: 5 });
  expect(result.rows[1]).toMatchObject({ page: "https://example.com/", folder: null });
});

it("warns about unequal or incomplete periods and passes through the first incomplete date", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-20", endDate: "2026-10-27" }, previous: { startDate: "2026-10-10", endDate: "2026-10-11" }, dataState: "all" }, async () => ({ rows: [], firstIncompleteDate: "2026-10-26" }), new Date("2026-10-28T12:00:00Z"));
  expect(result.meta.firstIncompleteDate).toBe("2026-10-26");
  expect(result.meta.warnings.join(" ")).toMatch(/not like-for-like/);
  expect(result.meta.warnings.join(" ")).toMatch(/incomplete/);
});

it("rejects reversed or invalid calendar ranges before fetching rows", async () => {
  await expect(comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-03", endDate: "2026-10-01" } }, async () => { throw new Error("unexpected fetch"); })).rejects.toThrow(/startDate must not be after endDate/);
  await expect(comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-02-30", endDate: "2026-03-05" } }, async () => { throw new Error("unexpected fetch"); })).rejects.toThrow(/valid YYYY-MM-DD/);
});

it("pages until a short page and reports capped series as potentially incomplete", async () => {
  const full = Array.from({ length: 25000 }, () => ({ keys: ["https://example.com/blog/page"], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }));
  const current = { startDate: "2026-10-01", endDate: "2026-10-02" };
  const short = await comparePeriods({ siteUrl: "https://example.com/", current }, async query => ({ rows: query.startDate !== "2026-10-01" ? [] : query.startRow === 0 ? full : query.startRow === 25000 ? [full[0]] : (() => { throw new Error("fetch continued past short page"); })() }));
  expect(short.meta).toMatchObject({ rowsFetched: { current: 25001, previous: 0 }, truncated: false });
  expect(short.rows[0].current).toEqual({ clicks: 25001, impressions: 250010, ctr: 0.1, position: 3 });
  const capped = await comparePeriods({ siteUrl: "https://example.com/", current }, async query => ({ rows: query.startDate !== "2026-10-01" ? [] : query.startRow < 100000 ? full : (() => { throw new Error("fetch exceeded cap"); })() }));
  expect(capped.meta).toMatchObject({ rowsFetched: { current: 100000, previous: 0 }, truncated: true });
  expect(capped.meta.warnings.join(" ")).toMatch(/new\/lost statuses may be wrong because the row cap was hit/);
});

it("applies the impressions floor to either period before ranking and limiting", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" }, minImpressions: 100, limit: 1 }, async ({ startDate }) => ({ rows: startDate === "2026-10-01" ? [
    { keys: ["https://example.com/a"], clicks: 5, impressions: 200, ctr: 0.025, position: 2 },
    { keys: ["https://example.com/b"], clicks: 8, impressions: 20, ctr: 0.4, position: 4 },
    { keys: ["https://example.com/c"], clicks: 1, impressions: 3, ctr: 1 / 3, position: 1 },
  ] : [
    { keys: ["https://example.com/a"], clicks: 10, impressions: 50, ctr: 0.2, position: 2 },
    { keys: ["https://example.com/b"], clicks: 18, impressions: 300, ctr: 0.06, position: 4 },
    { keys: ["https://example.com/c"], clicks: 40, impressions: 45, ctr: 40 / 45, position: 1 },
  ] }));
  expect(result.meta).toMatchObject({ rowsMatched: 2, rowsReturned: 1 });
  expect(result.rows.map(row => row.page)).toEqual(["https://example.com/b"]);
});

for (const [sortBy, expected] of [
  ["clicksDelta", ["c", "a", "b"]],
  ["impressionsDelta", ["b", "a", "c"]],
  ["positionDelta", ["b", "a", "c"]],
  ["ctrDelta", ["c", "a", "b"]],
  ["clicks", ["b", "a", "c"]],
] as const) {
  it(`ranks ${sortBy} worst first by default and honors an explicit order`, async () => {
    const options: ComparisonOptions = { siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" }, sortBy };
    const fetchRows = async ({ startDate }: { startDate: string }) => ({ rows: startDate === "2026-10-01" ? [
      { keys: ["https://example.com/a"], clicks: 5, impressions: 50, ctr: 0.1, position: 3 },
      { keys: ["https://example.com/b"], clicks: 8, impressions: 80, ctr: 0.1, position: 8 },
      { keys: ["https://example.com/c"], clicks: 3, impressions: 90, ctr: 1 / 30, position: 5 },
    ] : [
      { keys: ["https://example.com/a"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { keys: ["https://example.com/b"], clicks: 10, impressions: 200, ctr: 0.05, position: 4 },
      { keys: ["https://example.com/c"], clicks: 20, impressions: 100, ctr: 0.2, position: 10 },
    ] });
    const result = await comparePeriods(options, fetchRows);
    expect(result.rows.map(row => row.folder)).toEqual(expected);
    const reverse = await comparePeriods({ ...options, order: sortBy === "positionDelta" || sortBy === "clicks" ? "asc" : "desc" }, fetchRows);
    expect(reverse.rows.map(row => row.folder)).toEqual([...expected].reverse());
  });
}

it("adds ranked queries from one grouped series while retaining independent page totals", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" }, topQueries: 2 }, async ({ startDate, dimensions }) => ({ rows: dimensions.join("+") === "page+query" ? [
    { keys: ["https://example.com/blog/page/#part", "secondary"], clicks: 1, impressions: 5, ctr: 0.2, position: 5 },
    { keys: ["https://example.com/blog/page", "primary"], clicks: 4, impressions: 40, ctr: 0.1, position: 9 },
    { keys: ["https://example.com/blog/page/", "secondary"], clicks: 2, impressions: 15, ctr: 2 / 15, position: 1 },
    { keys: ["https://example.com/blog/page", "third"], clicks: 2, impressions: 10, ctr: 0.2, position: 4 },
  ] : startDate === "2026-10-01" ? [{ keys: ["https://example.com/blog/page"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 }] : [] }));
  expect(result.rows[0].current).toEqual({ clicks: 100, impressions: 1000, ctr: 0.1, position: 3 });
  expect(result.rows[0].topQueries).toEqual([
    { query: "primary", clicks: 4, impressions: 40, position: 9 },
    { query: "secondary", clicks: 3, impressions: 20, position: 2 },
  ]);
  expect(result.meta.rowsFetched).toEqual({ current: 1, previous: 0 });
});

it("rejects query enrichment for dimensions that do not represent page totals", async () => {
  for (const dimension of ["query", "page+query"] as const) {
    await expect(comparePeriods({ siteUrl: "sc-domain:example.com", dimension, topQueries: 1 }, async () => ({ rows: [] }))).rejects.toThrow(/topQueries.*page/);
  }
});

it("keeps query text as the join key and puts absent positions last in either order", async () => {
  const fetchRows = async ({ startDate }: { startDate: string }) => ({ rows: startDate === "2026-10-01" ? [
    { keys: ["new query"], clicks: 2, impressions: 10, ctr: 0.2, position: 8 },
    { keys: ["shared query"], clicks: 3, impressions: 20, ctr: 0.15, position: 8 },
  ] : [
    { keys: ["shared query"], clicks: 4, impressions: 20, ctr: 0.2, position: 5 },
    { keys: ["lost query"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
  ] });
  for (const order of ["asc", "desc"] as const) {
    const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" }, dimension: "query", sortBy: "positionDelta", order }, fetchRows);
    expect(result.rows[0]).toMatchObject({ query: "shared query", folder: null, positionDelta: 3 });
    expect(result.rows[0].page).toBeUndefined();
    expect(result.rows.slice(1).map(row => row.positionDelta)).toEqual([null, null]);
  }
});

it("joins page and query together while preserving URL case and property variants", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" }, dimension: "page+query" }, async ({ startDate }) => ({ rows: startDate === "2026-10-01" ? [
    { keys: ["https://example.com/Page/#part", "one"], clicks: 2, impressions: 10, ctr: 0.2, position: 8 },
    { keys: ["https://example.com/page", "one"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    { keys: ["http://example.com/Page", "one"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    { keys: ["https://www.example.com/Page", "one"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
  ] : [
    { keys: ["https://example.com/Page", "one"], clicks: 4, impressions: 20, ctr: 0.2, position: 5 },
    { keys: ["https://example.com/Page", "two"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
  ] }));
  expect(result.rows).toHaveLength(5);
  expect(result.rows[0]).toMatchObject({ page: "https://example.com/Page", query: "one", folder: "Page", status: "both", clicksDelta: -2 });
  expect(result.rows.find(row => row.query === "two")).toMatchObject({ status: "lost" });
});

it("normalizes only the URL path while preserving query-string values", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" } }, async ({ startDate }) => ({ rows: [{ keys: [startDate === "2026-10-01" ? "https://example.com/blog/post/?next=/" : "https://example.com/blog/post?next=/"], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }] }));
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ page: "https://example.com/blog/post?next=/", status: "both" });
});

it("joins property-root URLs with and without the root slash", async () => {
  const result = await comparePeriods({ siteUrl: "sc-domain:example.com", current: { startDate: "2026-10-01", endDate: "2026-10-02" } }, async ({ startDate }) => ({ rows: [{ keys: [startDate === "2026-10-01" ? "https://example.com#part" : "https://example.com/"], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }] }));
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ page: "https://example.com/", folder: null, status: "both" });
});
