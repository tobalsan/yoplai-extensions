export interface Period { startDate: string; endDate: string }
export interface KeyEvent { eventName: string; countingMethod?: string | null; custom?: boolean }
export interface ReportRequest {
  dimensions: { name: string }[]; metrics: { name: string }[]; dateRanges: Period[];
  dimensionFilter?: Record<string, unknown>; metricFilter?: Record<string, unknown>;
  metricAggregations?: string[]; orderBys?: Record<string, unknown>[]; limit: number; offset: number;
}
export interface ReportRow { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }
export interface ReportResponse {
  dimensionHeaders?: { name: string }[]; metricHeaders?: { name: string }[];
  rows?: ReportRow[]; totals?: ReportRow[]; rowCount?: number;
  metadata?: { timeZone?: string; currencyCode?: string; subjectToThresholding?: boolean; dataLossFromOtherRow?: boolean; samplingMetadatas?: Record<string, unknown>[] };
}
export interface ComparisonOptions {
  property: string; timeZone: string; current?: Period; previous?: Period;
  dimension?: "landingPage" | "pagePath"; breakdown?: "channel"; keyEvents?: string[];
  hostName?: string; country?: string; pagePathRegex?: string; pagePaths?: string[]; channelGroup?: string;
  minSessions?: number; sortBy?: "sessionsDelta" | "keyEventsDelta" | "sessions" | "keyEvents";
  order?: "asc" | "desc"; limit?: number; aiReferralHosts?: string[];
}
const DAY = 86400000;
export const DEFAULT_AI_REFERRAL_HOSTS = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai"];
export function isAiReferral(sessionSource: string, hosts = DEFAULT_AI_REFERRAL_HOSTS) {
  const source = sessionSource.toLowerCase().replace(/^www\./, "");
  return hosts.some(host => {
    const normalized = host.toLowerCase().replace(/^www\./, "");
    return source === normalized || source.endsWith(`.${normalized}`);
  });
}
function shift(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function length(period: Period) { return (Date.parse(period.endDate) - Date.parse(period.startDate)) / DAY + 1; }
export interface Change { current: number | null; previous: number | null; delta: number | null; percentDelta: number | null }
export interface Metrics { sessions: number; engagedSessions: number; engagementRate: number; keyEvents: number | null; screenPageViews?: number; namedKeyEvents: Record<string, number> }
interface ChannelChange { sessions: Change; keyEvents: Change }
export interface ComparisonRow {
  pagePath: string; pageUrl: string | null; folder: string | null; status: "new" | "lost" | "both";
  sessions: Change; engagedSessions: Change; engagementRate: Change; keyEvents: Change; screenPageViews?: Change;
  namedKeyEvents: Record<string, Change>; channels?: Record<string, ChannelChange>; aiReferral?: ChannelChange;
}
function normalizePage(page: string) {
  const path = /^https?:\/\//i.test(page) ? new URL(page).pathname : page.split(/[?#]/)[0];
  return path.replace(/\/+$/, "") || "/";
}
function change(current: number | null, previous: number | null): Change {
  const delta = current === null || previous === null ? null : current - previous;
  return { current, previous, delta, percentDelta: previous === null || previous === 0 || delta === null ? null : delta / previous * 100 };
}
function values(row: ReportRow | undefined, names: string[], configured: boolean): Metrics {
  const data = Object.fromEntries(names.map((name, i) => [name, Number(row?.metricValues?.[i]?.value ?? 0)]));
  return { sessions: data.sessions, engagedSessions: data.engagedSessions, engagementRate: data.sessions ? data.engagedSessions / data.sessions : 0, keyEvents: configured ? data.keyEvents : null,
    ...(names.includes("screenPageViews") ? { screenPageViews: data.screenPageViews } : {}),
    namedKeyEvents: Object.fromEntries(names.filter(name => name.startsWith("keyEvents:")).map(name => [name.slice(10), data[name]])) };
}
function merge(rows: ReportRow[], names: string[], configured: boolean) {
  const result = new Map<string, Metrics>();
  for (const row of rows) {
    const key = normalizePage(row.dimensionValues?.[0]?.value ?? ""), data = values(row, names, configured), existing = result.get(key);
    if (!existing) { result.set(key, data); continue; }
    existing.sessions += data.sessions;
    existing.engagedSessions += data.engagedSessions;
    existing.keyEvents = configured ? (existing.keyEvents ?? 0) + (data.keyEvents ?? 0) : null;
    if (data.screenPageViews !== undefined) existing.screenPageViews = (existing.screenPageViews ?? 0) + data.screenPageViews;
    for (const name of Object.keys(data.namedKeyEvents)) existing.namedKeyEvents[name] += data.namedKeyEvents[name];
    existing.engagementRate = existing.sessions ? existing.engagedSessions / existing.sessions : 0;
  }
  return result;
}
export async function comparePeriods(options: ComparisonOptions, fetchReport: (body: ReportRequest) => Promise<ReportResponse>, listKeyEvents: () => Promise<KeyEvent[]>, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const endDate = shift(today, -3);
  const current = options.current ?? { startDate: shift(endDate, -27), endDate };
  for (const period of [current, options.previous].filter((value): value is Period => !!value)) {
    for (const date of [period.startDate, period.endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || shift(date, 0) !== date) throw new Error("Dates must be valid YYYY-MM-DD calendar dates");
    }
    if (period.startDate > period.endDate) throw new Error("startDate must not be after endDate");
  }
  const previousEnd = shift(current.startDate, -1);
  const previous = options.previous ?? { startDate: shift(previousEnd, 1 - length(current)), endDate: previousEnd };
  const warnings: string[] = [];
  if (length(current) !== length(previous)) warnings.push("Period lengths differ; deltas are not like-for-like.");
  if ([current, previous].some(period => period.endDate >= shift(today, -2))) warnings.push("Requested periods include incomplete days or GA4 processing delay (about 24 to 48 hours).");
  const query: ReportRequest = { dimensions: [{ name: options.dimension ?? "landingPage" }], metrics: ["sessions", "engagedSessions", "engagementRate", "keyEvents"].map(name => ({ name })), dateRanges: [], limit: 25000, offset: 0, metricAggregations: ["TOTAL"] };
  const pagePaths = options.pagePaths ? [...new Set(options.pagePaths.map(normalizePage))] : undefined;
  const filters = { ...(options.hostName ? { hostName: options.hostName } : {}), ...(options.country ? { country: options.country } : {}), ...(options.pagePathRegex ? { pagePathRegex: options.pagePathRegex } : {}), ...(options.channelGroup ? { channelGroup: options.channelGroup } : {}), ...(pagePaths ? { pagePaths } : {}) };
  const expressions: Record<string, unknown>[] = [];
  for (const [fieldName, value, matchType] of [["hostName", options.hostName, "EXACT"], ["country", options.country, "EXACT"], [query.dimensions[0].name, options.pagePathRegex, "PARTIAL_REGEXP"], ["sessionDefaultChannelGroup", options.channelGroup, "EXACT"]]) {
    if (value) expressions.push({ filter: { fieldName, stringFilter: { matchType, value, caseSensitive: true } } });
  }
  if (pagePaths) expressions.push({ filter: { fieldName: query.dimensions[0].name, inListFilter: { values: pagePaths.flatMap(path => path === "/" ? [path] : [path, `${path}/`]), caseSensitive: true } } });
  if (expressions.length) query.dimensionFilter = { andGroup: { expressions } };
  const configured = await listKeyEvents(), keyEventsConfigured = configured.length > 0;
  const namedEvents = [...new Set(options.keyEvents ?? [])].filter(name => {
    if (configured.some(event => event.eventName === name)) return true;
    warnings.push(`Unknown key event '${name}'; omitted from the report.`);
    return false;
  });
  if (!keyEventsConfigured) warnings.push("No key events are configured: conversion data unavailable.");
  if (options.dimension === "pagePath") query.metrics.push({ name: "screenPageViews" });
  query.metrics.push(...namedEvents.map(name => ({ name: `keyEvents:${name}` })));
  let subjectToThresholding = false, dataLossFromOtherRow = false, hasOther = false;
  const samplingMetadatas: Record<string, unknown>[] = [];
  const fetchSeries = async (period: Period, dimensions = query.dimensions) => {
    const rows: ReportRow[] = [];
    let totals: ReportRow[] | undefined, rowCount = 0;
    do {
      const response = await fetchReport({ ...query, dimensions, dateRanges: [period], offset: rows.length });
      subjectToThresholding ||= response.metadata?.subjectToThresholding ?? false;
      dataLossFromOtherRow ||= response.metadata?.dataLossFromOtherRow ?? false;
      samplingMetadatas.push(...(response.metadata?.samplingMetadatas ?? []));
      hasOther ||= (response.rows ?? []).some(row => row.dimensionValues?.some(value => value.value === "(other)"));
      totals ??= response.totals;
      rowCount = response.rowCount ?? response.rows?.length ?? 0;
      const page = response.rows ?? [];
      rows.push(...page.slice(0, 100000 - rows.length));
      if (!page.length) break;
    } while (rows.length < rowCount && rows.length < 100000);
    return { rows, totals, truncated: rowCount > rows.length };
  };
  const currentPage = await fetchSeries(current);
  const previousPage = await fetchSeries(previous);
  if ([currentPage, previousPage].some(page => page.rows.length > 0 && !page.totals?.[0]?.metricValues?.length)) throw new Error("GA4 did not return the requested TOTAL aggregation; retry the report rather than sum page sessions.");
  const channelDimensions = [...query.dimensions, { name: "sessionDefaultChannelGroup" }, { name: "sessionSource" }];
  const currentChannels = options.breakdown ? await fetchSeries(current, channelDimensions) : undefined;
  const previousChannels = options.breakdown ? await fetchSeries(previous, channelDimensions) : undefined;
  const truncated = currentPage.truncated || previousPage.truncated || (currentChannels?.truncated ?? false) || (previousChannels?.truncated ?? false);
  if (truncated) warnings.push("Results are truncated; new/lost statuses may be wrong because rows are missing.");
  if (subjectToThresholding) warnings.push("GA4 results are subject to thresholding.");
  if (dataLossFromOtherRow || hasOther) warnings.push("GA4 results include (other) rows or data loss from the other row.");
  const names = query.metrics.map(metric => metric.name);
  const currentMap = merge(currentPage.rows ?? [], names, keyEventsConfigured), previousMap = merge(previousPage.rows ?? [], names, keyEventsConfigured);
  let rows: ComparisonRow[] = [];
  const pagePathsWithoutData = pagePaths?.filter(path => !currentMap.has(path) && !previousMap.has(path));
  for (const pagePath of pagePaths ?? new Set([...currentMap.keys(), ...previousMap.keys()])) {
    const current = currentMap.get(pagePath), previous = previousMap.get(pagePath);
    const a = current ?? values(undefined, names, keyEventsConfigured), b = previous ?? values(undefined, names, keyEventsConfigured);
    rows.push({ pagePath, pageUrl: options.hostName ? `https://${options.hostName}${pagePath}` : null, folder: pagePath.split("/")[1] || null,
      status: current && !previous ? "new" : previous && !current ? "lost" : "both", sessions: change(a.sessions, b.sessions), engagedSessions: change(a.engagedSessions, b.engagedSessions), engagementRate: change(a.engagementRate, b.engagementRate), keyEvents: change(a.keyEvents, b.keyEvents),
      ...(options.dimension === "pagePath" ? { screenPageViews: change(a.screenPageViews ?? 0, b.screenPageViews ?? 0) } : {}),
      namedKeyEvents: Object.fromEntries(namedEvents.map(name => [name, change(a.namedKeyEvents[name], b.namedKeyEvents[name])])) });
  }
  rows = rows.filter(row => Math.max(row.sessions.current ?? 0, row.sessions.previous ?? 0) >= (options.minSessions ?? 0));
  const rowsMatched = rows.length, sortBy = options.sortBy ?? "sessionsDelta";
  const order = options.order ?? (sortBy === "sessions" || sortBy === "keyEvents" ? "desc" : "asc");
  const sortValue = (row: ComparisonRow) => sortBy === "sessionsDelta" ? row.sessions.delta : sortBy === "keyEventsDelta" ? row.keyEvents.delta : row[sortBy].current;
  rows.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return (left - right) * (order === "asc" ? 1 : -1);
  });
  rows = rows.slice(0, options.limit ?? pagePaths?.length ?? 50);
  if (options.breakdown) {
    const groups = (page: typeof currentChannels) => {
      const channels = new Map<string, Map<string, ReportRow[]>>(), ai = new Map<string, ReportRow[]>();
      for (const row of page?.rows ?? []) {
        const path = normalizePage(row.dimensionValues?.[0]?.value ?? ""), channel = row.dimensionValues?.[1]?.value ?? "(not set)";
        const byChannel = channels.get(path) ?? new Map<string, ReportRow[]>();
        const channelRows = byChannel.get(channel) ?? [];
        channelRows.push(row);
        byChannel.set(channel, channelRows);
        channels.set(path, byChannel);
        if (isAiReferral(row.dimensionValues?.[2]?.value ?? "", options.aiReferralHosts)) {
          const aiRows = ai.get(path) ?? [];
          aiRows.push(row);
          ai.set(path, aiRows);
        }
      }
      return { channels, ai };
    };
    const a = groups(currentChannels), b = groups(previousChannels);
    const bucket = (current: ReportRow[] = [], previous: ReportRow[] = [], path: string): ChannelChange => {
      const a = merge(current, names, keyEventsConfigured).get(path) ?? values(undefined, names, keyEventsConfigured);
      const b = merge(previous, names, keyEventsConfigured).get(path) ?? values(undefined, names, keyEventsConfigured);
      return { sessions: change(a.sessions, b.sessions), keyEvents: change(a.keyEvents, b.keyEvents) };
    };
    for (const row of rows) {
      const current = a.channels.get(row.pagePath), previous = b.channels.get(row.pagePath);
      row.channels = Object.fromEntries([...new Set([...(current?.keys() ?? []), ...(previous?.keys() ?? [])])].map(channel => [channel, bucket(current?.get(channel), previous?.get(channel), row.pagePath)]));
      row.aiReferral = bucket(a.ai.get(row.pagePath), b.ai.get(row.pagePath), row.pagePath);
    }
  }
  return { rows, totals: { current: values(currentPage.totals?.[0], names, keyEventsConfigured), previous: values(previousPage.totals?.[0], names, keyEventsConfigured) }, meta: {
    current, previous, warnings, timezone: options.timeZone, timezoneNote: "GA4 dates use the property time zone; GSC uses Pacific time (America/Los_Angeles). No time zone conversion is applied.",
    filters, ...(pagePathsWithoutData ? { pagePathsWithoutData } : {}), rowsFetched: { current: currentPage.rows.length + (currentChannels?.rows.length ?? 0), previous: previousPage.rows.length + (previousChannels?.rows.length ?? 0) }, rowsMatched, rowsReturned: rows.length,
    truncated, subjectToThresholding, dataLossFromOtherRow, samplingMetadatas, keyEventsConfigured,
  } };
}
