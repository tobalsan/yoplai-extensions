import { describe, expect, it } from "vitest";
import { comparePeriods, type ReportRequest, type ReportResponse } from "./comparison.js";

const now = new Date("2026-10-29T02:00:00Z");
const empty = async (): Promise<ReportResponse> => ({ rowCount: 0 });
const events = async () => [{ eventName: "contact" }];
const options = { property: "properties/123", timeZone: "America/Los_Angeles" };

describe("GA4 comparison", () => {
  it("defaults to equal 28-day complete property-calendar periods with a three-day lag", async () => {
    const requests: ReportRequest[] = [];
    const result = await comparePeriods(options, async body => { requests.push(body); return empty(); }, events, now);
    expect(result.meta.current).toEqual({ startDate: "2026-09-28", endDate: "2026-10-25" });
    expect(result.meta.previous).toEqual({ startDate: "2026-08-31", endDate: "2026-09-27" });
    expect(requests.map(body => body.dateRanges)).toEqual([[result.meta.current], [result.meta.previous]]);
    expect(result.meta.warnings).toEqual([]);
    const asian = await comparePeriods({ ...options, timeZone: "Asia/Tokyo" }, empty, events, now);
    expect(asian.meta.current).toEqual({ startDate: "2026-09-29", endDate: "2026-10-26" });
  });
});

it("derives the previous period from current and warns for unequal or processing dates", async () => {
  const current = { startDate: "2026-10-01", endDate: "2026-10-07" };
  const result = await comparePeriods({ ...options, current }, empty, events, now);
  expect(result.meta.previous).toEqual({ startDate: "2026-09-24", endDate: "2026-09-30" });
  const recent = await comparePeriods({ ...options, current, previous: { startDate: "2026-10-27", endDate: "2026-10-30" } }, empty, events, now);
  expect(recent.meta.warnings.join(" ")).toMatch(/not like-for-like/);
  expect(recent.meta.warnings.join(" ")).toMatch(/processing delay/);
  for (const current of [{ startDate: "2026-02-30", endDate: "2026-03-01" }, { startDate: "2026-10-07", endDate: "2026-10-01" }, { startDate: "2026-2-01", endDate: "2026-02-02" }]) {
    await expect(comparePeriods({ ...options, current }, empty, events, now)).rejects.toThrow(/date|YYYY/i);
  }
});

function report(rows: [string, number, number, number][], totalSessions = 100): ReportResponse {
  return {
    rows: rows.map(([path, sessions, engaged, keyEvents]) => ({ dimensionValues: [{ value: path }], metricValues: [sessions, engaged, 0.99, keyEvents].map(value => ({ value: String(value) })) })),
    rowCount: rows.length,
    totals: [{ metricValues: [totalSessions, 40, 0.4, 8].map(value => ({ value: String(value) })) }],
  };
}

it("joins normalized page keys, recomputes engagement, and uses API totals instead of summing page sessions", async () => {
  const result = await comparePeriods({ ...options, hostName: "www.example.com" }, async body => body.dateRanges[0].endDate === "2026-10-25"
    ? report([["/Blog/A/?x=1#part", 10, 4, 2], ["/Blog/A", 20, 8, 1], ["/", 5, 1, 0], ["/new", 7, 2, 1]])
    : report([["/Blog/A/", 60, 30, 6], ["/lost", 10, 2, 1]], 200), events, now);
  const row = result.rows.find(row => row.pagePath === "/Blog/A")!;
  expect(row).toMatchObject({ pageUrl: "https://www.example.com/Blog/A", folder: "Blog", status: "both", sessions: { current: 30, previous: 60, delta: -30, percentDelta: -50 }, engagementRate: { current: 0.4, previous: 0.5, delta: expect.closeTo(-0.1) }, keyEvents: { current: 3, previous: 6 } });
  expect(result.rows.find(row => row.pagePath === "/new")).toMatchObject({ status: "new", sessions: { previous: 0, percentDelta: null } });
  expect(result.rows.find(row => row.pagePath === "/lost")).toMatchObject({ status: "lost", sessions: { current: 0 } });
  expect(result.rows.find(row => row.pagePath === "/")).toMatchObject({ folder: null });
  expect(result.totals.current.sessions).toBe(100);
  expect(result.totals.previous.sessions).toBe(200);
  const noHost = await comparePeriods(options, async () => report([["/", 1, 1, 0]]), events, now);
  expect(noHost.rows[0].pageUrl).toBeNull();
});

it("pages to rowCount, caps each series at 100000, and preserves TOTAL and quality evidence", async () => {
  const offsets: number[] = [];
  const repeated = report([["/same", 1, 1, 0]]).rows![0];
  const result = await comparePeriods(options, async body => {
    offsets.push(body.offset);
    return { rowCount: 100001, rows: Array.from({ length: 25000 }, () => repeated), totals: report([], 765432).totals,
      metadata: body.offset === 25000 ? { subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "20", samplingSpaceSize: "100" }] } : {} };
  }, events, now);
  expect(offsets).toEqual([0, 25000, 50000, 75000, 0, 25000, 50000, 75000]);
  expect(result.meta).toMatchObject({ rowsFetched: { current: 100000, previous: 100000 }, truncated: true, subjectToThresholding: true, dataLossFromOtherRow: true });
  expect(result.meta.samplingMetadatas).toContainEqual({ samplesReadCount: "20", samplingSpaceSize: "100" });
  expect(result.totals.current.sessions).toBe(765432);
  expect(result.meta.warnings.join(" ")).toMatch(/new\/lost/);
  expect(result.meta.warnings.join(" ")).toMatch(/threshold/i);
  expect(result.meta.warnings.join(" ")).toMatch(/other/);
  const other = await comparePeriods(options, async () => report([["(other)", 1, 0, 0]]), events, now);
  expect(other.meta.warnings.join(" ")).toMatch(/other/);
});

it("requests known named key events and page views only for pagePath, and marks missing setup unavailable", async () => {
  const requests: ReportRequest[] = [];
  const result = await comparePeriods({ ...options, dimension: "pagePath", keyEvents: ["contact", "missing"] }, async body => {
    requests.push(body);
    const value: Record<string, string> = { sessions: "10", engagedSessions: "4", engagementRate: "0.4", keyEvents: "3", screenPageViews: "45", "keyEvents:contact": "2" };
    return { rowCount: 1, rows: [{ dimensionValues: [{ value: "/a" }], metricValues: body.metrics.map(metric => ({ value: value[metric.name] })) }], totals: [{ metricValues: body.metrics.map(metric => ({ value: value[metric.name] })) }] };
  }, events, now);
  expect(requests[0].metrics.map(metric => metric.name)).toEqual(["sessions", "engagedSessions", "engagementRate", "keyEvents", "screenPageViews", "keyEvents:contact"]);
  expect(result.rows[0]).toMatchObject({ screenPageViews: { current: 45 }, namedKeyEvents: { contact: { current: 2, previous: 2, delta: 0 } } });
  expect(result.meta.warnings.join(" ")).toMatch(/Unknown key event.*missing/);
  const unavailable = await comparePeriods(options, async body => { expect(body.metrics.map(metric => metric.name)).not.toContain("screenPageViews"); return report([["/a", 10, 4, 0]]); }, async () => [], now);
  expect(unavailable.meta.keyEventsConfigured).toBe(false);
  expect(unavailable.meta.warnings.join(" ")).toMatch(/conversion data unavailable/);
  expect(unavailable.rows[0]).toMatchObject({ sessions: { current: 10 }, keyEvents: { current: null, previous: null, delta: null, percentDelta: null } });
  expect(unavailable.totals.current.keyEvents).toBeNull();
});

it("ANDs filters, expands exact pages to trailing-slash variants, and returns requested pages without data", async () => {
  const requests: ReportRequest[] = [];
  const result = await comparePeriods({ ...options, hostName: "www.example.com", country: "United States", pagePathRegex: "^/features/", channelGroup: "Organic Search", pagePaths: ["https://www.example.com/features/A/?utm=x#part", "/missing", "/"] }, async body => { requests.push(body); return report([["/features/A/", 10, 4, 1], ["/unrequested", 20, 6, 0]]); }, events, now);
  expect(requests[0].dimensionFilter).toEqual({ andGroup: { expressions: [
    { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: "www.example.com", caseSensitive: true } } },
    { filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "United States", caseSensitive: true } } },
    { filter: { fieldName: "landingPage", stringFilter: { matchType: "PARTIAL_REGEXP", value: "^/features/", caseSensitive: true } } },
    { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search", caseSensitive: true } } },
    { filter: { fieldName: "landingPage", inListFilter: { values: ["/features/A", "/features/A/", "/missing", "/missing/", "/"], caseSensitive: true } } },
  ] } });
  expect(result.rows.map(row => row.pagePath).sort()).toEqual(["/", "/features/A", "/missing"]);
  expect(result.rows.find(row => row.pagePath === "/missing")).toMatchObject({ sessions: { current: 0, previous: 0 } });
  expect(result.meta.pagePathsWithoutData).toEqual(["/missing", "/"]);
  expect(result.meta.filters).toMatchObject({ pagePaths: ["/features/A", "/missing", "/"], country: "United States" });
});

it("applies the larger-period session floor, metric-specific ordering, and limit after matching", async () => {
  const fetcher = async (body: ReportRequest) => body.dateRanges[0].endDate === "2026-10-25" ? report([["/a", 10, 2, 5], ["/b", 20, 8, 1], ["/c", 5, 1, 3]]) : report([["/a", 30, 15, 1], ["/b", 10, 5, 5]]);
  for (const [sortBy, expected] of [["sessionsDelta", ["/a", "/b"]], ["keyEventsDelta", ["/b", "/a"]], ["sessions", ["/b", "/a"]], ["keyEvents", ["/a", "/b"]]] as const) {
    const result = await comparePeriods({ ...options, minSessions: 10, sortBy }, fetcher, events, now);
    expect(result.rows.map(row => row.pagePath)).toEqual(expected);
  }
  const limited = await comparePeriods({ ...options, minSessions: 10, order: "desc", limit: 1 }, fetcher, events, now);
  expect(limited.rows.map(row => row.pagePath)).toEqual(["/b"]);
  expect(limited.meta).toMatchObject({ rowsMatched: 2, rowsReturned: 1 });
});

it("groups channels with a separate identifiable AI-referral subset and configurable hosts", async () => {
  const sources = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai", "WWW.CHATGPT.COM", "search.perplexity.ai", "notchatgpt.com", "chatgpt.com.evil.example", "google.com"];
  const fetcher = async (body: ReportRequest): Promise<ReportResponse> => {
    if (body.dimensions.length === 1) return report([["/a", 11, 5, 11]]);
    expect(body.dimensions.map(dimension => dimension.name)).toEqual(["landingPage", "sessionDefaultChannelGroup", "sessionSource"]);
    expect(body.dimensionFilter).toMatchObject({ andGroup: { expressions: [{ filter: { fieldName: "landingPage", inListFilter: { values: ["/a", "/a/"] } } }] } });
    return { rowCount: sources.length, metadata: { subjectToThresholding: true }, rows: sources.map(source => ({ dimensionValues: [{ value: "/a/" }, { value: "Referral" }, { value: source }], metricValues: ["1", "1", "1", "1"].map(value => ({ value })) })) };
  };
  const result = await comparePeriods({ ...options, pagePaths: ["/a"], breakdown: "channel" }, fetcher, events, now);
  expect(result.rows[0].channels).toEqual({ Referral: { sessions: { current: 11, previous: 11, delta: 0, percentDelta: 0 }, keyEvents: { current: 11, previous: 11, delta: 0, percentDelta: 0 } } });
  expect(result.rows[0].aiReferral).toMatchObject({ sessions: { current: 8, previous: 8 }, keyEvents: { current: 8 } });
  expect(result.meta.subjectToThresholding).toBe(true);
  const override = await comparePeriods({ ...options, pagePaths: ["/a"], breakdown: "channel", aiReferralHosts: ["google.com"] }, fetcher, events, now);
  expect(override.rows[0].aiReferral?.sessions.current).toBe(2);
});

it("never presents invented zero totals when a nonempty main report omits TOTAL", async () => {
  await expect(comparePeriods(options, async () => ({ rowCount: 1, rows: report([["/a", 10, 4, 1]]).rows }), events, now)).rejects.toThrow(/TOTAL/);
});
