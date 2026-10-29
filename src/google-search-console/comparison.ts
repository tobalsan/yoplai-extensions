export interface Period { startDate: string; endDate: string }
export interface Filter {
  dimension: "page" | "query" | "country" | "device";
  operator: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
}
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
export interface AnalyticsRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface AnalyticsQuery extends Period {
  siteUrl: string; dimensions: string[]; filters?: Filter[]; type?: SearchType;
  dataState?: "final" | "all"; rowLimit: number; startRow: number;
}
export interface AnalyticsPage { rows?: AnalyticsRow[]; firstIncompleteDate?: string | null }
export type FetchPage = (query: AnalyticsQuery) => Promise<AnalyticsPage>;
export interface ComparisonOptions {
  siteUrl: string; current?: Period; previous?: Period;
  dimension?: "page" | "query" | "page+query"; filters?: Filter[]; type?: SearchType;
  dataState?: "final" | "all"; minImpressions?: number;
  sortBy?: "clicksDelta" | "impressionsDelta" | "positionDelta" | "ctrDelta" | "clicks";
  order?: "asc" | "desc"; limit?: number; topQueries?: number;
}
export interface Metrics { clicks: number; impressions: number; ctr: number; position: number | null }
export interface ComparisonRow {
  page?: string; query?: string; folder: string | null;
  current: Metrics; previous: Metrics;
  clicksDelta: number; impressionsDelta: number; ctrDelta: number; positionDelta: number | null;
  clicksPercentDelta: number | null; impressionsPercentDelta: number | null;
  ctrPercentDelta: number | null; positionPercentDelta: number | null;
  status: "new" | "lost" | "both";
  topQueries?: { query: string; clicks: number; impressions: number; position: number | null }[];
}
const DAY = 86400000;
const PAGE_SIZE = 25000;
const ROW_CAP = 100000;
function shift(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function length(period: Period) { return (Date.parse(period.endDate) - Date.parse(period.startDate)) / DAY + 1; }
function normalizePage(page: string) {
  const withoutFragment = page.split("#")[0];
  const url = new URL(withoutFragment);
  const queryAt = withoutFragment.indexOf("?");
  const path = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutFragment.slice(queryAt);
  return (url.pathname === "/" ? (path.endsWith("/") ? path : `${path}/`) : path.replace(/\/+$/, "")) + query;
}
function merge(rows: AnalyticsRow[], dimension: ComparisonOptions["dimension"]) {
  const result = new Map<string, AnalyticsRow>();
  for (const row of rows) {
    const keys = [...row.keys];
    if (dimension !== "query") keys[0] = normalizePage(keys[0]);
    const key = JSON.stringify(keys), existing = result.get(key);
    if (!existing) { result.set(key, { ...row, keys }); continue; }
    const impressions = existing.impressions + row.impressions;
    result.set(key, { keys, clicks: existing.clicks + row.clicks, impressions,
      ctr: impressions ? (existing.clicks + row.clicks) / impressions : 0,
      position: impressions ? (existing.position * existing.impressions + row.position * row.impressions) / impressions : 0 });
  }
  return result;
}
export async function comparePeriods(options: ComparisonOptions, fetchPage: FetchPage, now = new Date()) {
  if (options.topQueries && (options.dimension ?? "page") !== "page") throw new Error("topQueries is only valid with dimension page");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
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
  const query = { siteUrl: options.siteUrl, dimensions: (options.dimension ?? "page").split("+"), filters: options.filters, type: options.type ?? "web", dataState: options.dataState ?? "final", rowLimit: PAGE_SIZE, startRow: 0 };

  const fetchSeries = async (period: Period, dimensions = query.dimensions) => {
    const rows: AnalyticsRow[] = [], incompleteDates: string[] = [];
    let truncated = false;
    while (rows.length < ROW_CAP) {
      const page = await fetchPage({ ...query, ...period, dimensions, startRow: rows.length });
      if (page.firstIncompleteDate) incompleteDates.push(page.firstIncompleteDate);
      rows.push(...(page.rows ?? []));
      if ((page.rows?.length ?? 0) < query.rowLimit) break;
      if (rows.length >= ROW_CAP) truncated = true;
    }
    return { rows, firstIncompleteDate: incompleteDates.sort()[0] ?? null, truncated };
  };
  const currentPage = await fetchSeries(current);
  const previousPage = await fetchSeries(previous);
  const currentRows = currentPage.rows ?? [], previousRows = previousPage.rows ?? [];
  const queryPage = options.topQueries ? await fetchSeries(current, ["page", "query"]) : null;
  const incompleteDates = [currentPage.firstIncompleteDate, previousPage.firstIncompleteDate, queryPage?.firstIncompleteDate].filter((date): date is string => !!date).sort();
  const firstIncompleteDate = incompleteDates[0] ?? null;
  const truncated = currentPage.truncated || previousPage.truncated || (queryPage?.truncated ?? false);
  const warnings: string[] = [];
  if (truncated) warnings.push("Results are truncated; new/lost statuses may be wrong because the row cap was hit.");
  if (length(current) !== length(previous)) warnings.push("Period lengths differ; deltas are not like-for-like.");
  if ([current, previous].some(period => period.endDate > endDate || options.dataState === "all" && firstIncompleteDate !== null && period.endDate >= firstIncompleteDate)) warnings.push("Requested periods include potentially incomplete days.");
  const currentMap = merge(currentRows, options.dimension);
  const previousMap = merge(previousRows, options.dimension);
  let rows: ComparisonRow[] = [];
  for (const key of new Set([...currentMap.keys(), ...previousMap.keys()])) {
    const currentRow = currentMap.get(key), previousRow = previousMap.get(key);
    const keys = (currentRow ?? previousRow)!.keys;
    const dimension = options.dimension ?? "page";
    const page = dimension !== "query" ? keys[0] : undefined;
    const query = dimension !== "page" ? keys[dimension === "query" ? 0 : 1] : undefined;
    const values = (row?: AnalyticsRow): Metrics => row ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position } : { clicks: 0, impressions: 0, ctr: 0, position: null };
    const current = values(currentRow), previous = values(previousRow);
    const percent = (value: number, before: number) => before === 0 ? null : (value - before) / before * 100;
    rows.push({ ...(page === undefined ? {} : { page }), ...(query === undefined ? {} : { query }), folder: page ? new URL(page).pathname.split("/")[1] || null : null,
      current, previous, clicksDelta: current.clicks - previous.clicks, impressionsDelta: current.impressions - previous.impressions, ctrDelta: current.ctr - previous.ctr,
      positionDelta: current.position === null || previous.position === null ? null : current.position - previous.position,
      clicksPercentDelta: percent(current.clicks, previous.clicks), impressionsPercentDelta: percent(current.impressions, previous.impressions), ctrPercentDelta: percent(current.ctr, previous.ctr),
      positionPercentDelta: current.position === null || previous.position === null ? null : percent(current.position, previous.position), status: !previousRow ? "new" : !currentRow ? "lost" : "both" });
  }
  rows = rows.filter(row => Math.max(row.current.impressions, row.previous.impressions) >= (options.minImpressions ?? 0));
  const rowsMatched = rows.length;
  const sortBy = options.sortBy ?? "clicksDelta";
  const order = options.order ?? (sortBy === "positionDelta" || sortBy === "clicks" ? "desc" : "asc");
  const sortValue = (row: ComparisonRow) => sortBy === "clicks" ? row.current.clicks : row[sortBy];
  rows.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return (left - right) * (order === "asc" ? 1 : -1);
  });
  rows = rows.slice(0, options.limit ?? 50);
  if (queryPage) {
    const queries = merge(queryPage.rows, "page+query");
    const byPage = new Map<string, NonNullable<ComparisonRow["topQueries"]>>();
    for (const query of queries.values()) {
      const grouped = byPage.get(query.keys[0]) ?? [];
      grouped.push({ query: query.keys[1], clicks: query.clicks, impressions: query.impressions, position: query.position });
      byPage.set(query.keys[0], grouped);
    }
    for (const row of rows) row.topQueries = (byPage.get(row.page!) ?? []).sort((a, b) => b.clicks - a.clicks).slice(0, options.topQueries);
  }
  return { rows, meta: { current, previous, filters: options.filters ?? [], searchType: options.type ?? "web", dataState: options.dataState ?? "final", timezone: "America/Los_Angeles" as const, firstIncompleteDate, rowsFetched: { current: currentRows.length, previous: previousRows.length }, rowsMatched, rowsReturned: rows.length, truncated, warnings } };
}
