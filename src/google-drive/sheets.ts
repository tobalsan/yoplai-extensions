/** Pure Sheets helpers ported from the gsheets extension. */
type SheetValues = string[][];

const SPREADSHEET_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

export function extractSpreadsheetId(input: {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
}): string {
  if (input.spreadsheetId?.trim()) return input.spreadsheetId.trim();
  const match = input.spreadsheetUrl?.match(SPREADSHEET_URL_RE);
  if (match?.[1]) return match[1];
  throw new Error("Provide spreadsheetId or a valid spreadsheetUrl.");
}

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function trimTrailingEmptyCells(row: unknown[]): string[] {
  const trimmed = row.map((cell) => String(cell ?? ""));
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]?.trim()) {
    trimmed.pop();
  }
  return trimmed;
}

export function headerRowScore(row: unknown[]): number {
  const trimmed = trimTrailingEmptyCells(row);
  const nonEmpty = trimmed.map((cell) => cell.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return -1;
  const alpha = nonEmpty.filter((cell) => /[A-Za-z]/.test(cell)).length;
  const numericLike = nonEmpty.filter((cell) =>
    /^[$€£¥%0-9,./:\-()\s]+$/.test(cell),
  ).length;
  return nonEmpty.length * 10 + alpha * 3 - numericLike * 2;
}

export function detectHeaderRow(values: SheetValues, maxScan = 10): {
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

export function rowsFromValues(values: SheetValues, headerRowIndex: number, headers: string[]): Record<string, string>[] {
  return values.slice(headerRowIndex).map((row) => {
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      entry[header] = String(row[index] ?? "");
    });
    return entry;
  });
}

export function filterColumns(
  rows: Record<string, string>[],
  headers: string[],
  requestedColumns?: string[],
): {
  rows: Record<string, string>[];
  headers: string[];
  requestedColumns?: string[];
  missingColumns?: string[];
} {
  if (!requestedColumns?.length) return { rows, headers };

  const available = new Set(headers);
  const selected = requestedColumns.filter((column) => available.has(column));
  const missing = requestedColumns.filter((column) => !available.has(column));
  return {
    rows: rows.map((row) => {
      const entry: Record<string, string> = {};
      selected.forEach((column) => {
        entry[column] = row[column] ?? "";
      });
      return entry;
    }),
    headers: selected,
    requestedColumns,
    missingColumns: missing.length > 0 ? missing : undefined,
  };
}
export function normalizeValues(values: unknown): SheetValues {
  if (!Array.isArray(values)) return [];
  return values.map((row) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [],
  );
}
