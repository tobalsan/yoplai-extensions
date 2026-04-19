import { google, type drive_v3, type sheets_v4 } from "googleapis";

import type {
  GSheetsConfig,
  InspectSpreadsheetParams,
  ListSpreadsheetsParams,
  ReadRangeParams,
  ReadSheetParams,
} from "./models.js";

const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const SPREADSHEET_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

type SheetValues = string[][];

function extractSpreadsheetId(input: {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
}): string {
  if (input.spreadsheetId?.trim()) return input.spreadsheetId.trim();
  const match = input.spreadsheetUrl?.match(SPREADSHEET_URL_RE);
  if (match?.[1]) return match[1];
  throw new Error("Provide spreadsheetId or a valid spreadsheetUrl.");
}

function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function trimTrailingEmptyCells(row: unknown[]): string[] {
  const trimmed = row.map((cell) => String(cell ?? ""));
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]?.trim()) {
    trimmed.pop();
  }
  return trimmed;
}

function headerRowScore(row: unknown[]): number {
  const trimmed = trimTrailingEmptyCells(row);
  const nonEmpty = trimmed.map((cell) => cell.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return -1;
  const alpha = nonEmpty.filter((cell) => /[A-Za-z]/.test(cell)).length;
  const numericLike = nonEmpty.filter((cell) =>
    /^[$€£¥%0-9,./:\-()\s]+$/.test(cell),
  ).length;
  return nonEmpty.length * 10 + alpha * 3 - numericLike * 2;
}

function detectHeaderRow(values: SheetValues, maxScan = 10): {
  headerRowIndex: number | null;
  headers: string[];
} {
  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < Math.min(values.length, maxScan); index += 1) {
    const score = headerRowScore(values[index] ?? []);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex < 0) return { headerRowIndex: null, headers: [] };
  const headers = trimTrailingEmptyCells(values[bestIndex] ?? []);
  return {
    headerRowIndex: headers.length > 0 ? bestIndex + 1 : null,
    headers,
  };
}

function rowsFromValues(values: SheetValues, headerRowIndex: number, headers: string[]): Record<string, string>[] {
  return values.slice(headerRowIndex).map((row) => {
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      entry[header] = String(row[index] ?? "");
    });
    return entry;
  });
}

function parseServiceAccountJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Invalid Google service account JSON.");
  }
}
function normalizeValues(values: unknown): SheetValues {
  if (!Array.isArray(values)) return [];
  return values.map((row) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [],
  );
}

export class GSheetsClient {
  private readonly drive: drive_v3.Drive;
  private readonly sheets: sheets_v4.Sheets;

  constructor(config: GSheetsConfig) {
    const credentials = parseServiceAccountJson(config.serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    });
    this.drive = google.drive({ version: "v3", auth });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  async validate(): Promise<{ ok: true }> {
    await this.drive.files.list({
      pageSize: 1,
      q: `mimeType='${SPREADSHEET_MIME_TYPE}' and trashed=false`,
      fields: "files(id)",
    });
    return { ok: true };
  }

  async listSpreadsheets(params: ListSpreadsheetsParams): Promise<Record<string, unknown>> {
    const filters = [`mimeType='${SPREADSHEET_MIME_TYPE}'`, "trashed=false"];
    if (params.query?.trim()) {
      filters.push(`name contains '${escapeDriveQueryValue(params.query.trim())}'`);
    }
    const response = await this.drive.files.list({
      pageSize: params.pageSize,
      q: filters.join(" and "),
      fields: "files(id,name,modifiedTime,webViewLink),nextPageToken",
      orderBy: "modifiedTime desc",
    });
    const files = response.data.files ?? [];
    return {
      spreadsheets: files.map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "",
        url: file.webViewLink ?? (file.id ? spreadsheetUrl(file.id) : ""),
        lastModified: file.modifiedTime ?? null,
      })),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async inspectSpreadsheet(params: InspectSpreadsheetParams): Promise<Record<string, unknown>> {
    const spreadsheetId = extractSpreadsheetId(params);
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
      fields: "spreadsheetId,properties.title,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
    });

    const tabs = await Promise.all(
      (spreadsheet.data.sheets ?? []).map(async (sheet) => {
        const props = sheet.properties;
        const title = props?.title ?? "";
        const valuesResponse = title
          ? await this.sheets.spreadsheets.values.get({
              spreadsheetId,
              range: `${quoteSheetName(title)}!1:${params.maxHeaderScanRows}`,
              majorDimension: "ROWS",
            })
          : undefined;
        const values = normalizeValues(valuesResponse?.data.values);
        const detected = detectHeaderRow(values, params.maxHeaderScanRows);
        return {
          tabName: title,
          sheetId: props?.sheetId ?? null,
          index: props?.index ?? null,
          rowCount: props?.gridProperties?.rowCount ?? null,
          columnCount: props?.gridProperties?.columnCount ?? null,
          headers: detected.headers,
          headerRowIndex: detected.headerRowIndex,
          isEmpty: values.length === 0 || !values.some((row) => row.some((cell) => cell.trim())),
        };
      }),
    );

    return {
      spreadsheetId,
      spreadsheetTitle: spreadsheet.data.properties?.title ?? "",
      spreadsheetUrl: spreadsheetUrl(spreadsheetId),
      tabs,
    };
  }

  async readSheet(params: ReadSheetParams): Promise<Record<string, unknown>> {
    const spreadsheetId = extractSpreadsheetId(params);
    const valuesResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(params.tabName),
      majorDimension: "ROWS",
    });
    const values = normalizeValues(valuesResponse.data.values);
    if (values.length === 0) {
      return {
        spreadsheetId,
        spreadsheetUrl: spreadsheetUrl(spreadsheetId),
        tabName: params.tabName,
        headerRowIndex: null,
        headers: [],
        rows: [],
      };
    }

    const detected =
      params.headerRowIndex > 0
        ? {
            headerRowIndex: params.headerRowIndex,
            headers: trimTrailingEmptyCells(values[params.headerRowIndex - 1] ?? []),
          }
        : detectHeaderRow(values);
    const headerRowIndex = detected.headerRowIndex ?? 1;

    return {
      spreadsheetId,
      spreadsheetUrl: spreadsheetUrl(spreadsheetId),
      tabName: params.tabName,
      headerRowIndex: detected.headerRowIndex,
      headers: detected.headers,
      rows: rowsFromValues(values, headerRowIndex, detected.headers),
    };
  }

  async readRange(params: ReadRangeParams): Promise<Record<string, unknown>> {
    const spreadsheetId = extractSpreadsheetId(params);
    const valuesResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: params.range,
      majorDimension: params.majorDimension,
    });
    return {
      spreadsheetId,
      spreadsheetUrl: spreadsheetUrl(spreadsheetId),
      range: valuesResponse.data.range ?? params.range,
      majorDimension: valuesResponse.data.majorDimension ?? params.majorDimension,
      values: normalizeValues(valuesResponse.data.values),
    };
  }
}
