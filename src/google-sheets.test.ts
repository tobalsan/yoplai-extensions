import { afterEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveClient, type DriveFetch } from "./google-drive/client.js";
import { GSheetsClient } from "./gsheets/client.js";

/**
 * Both Sheets transports (service-account `gsheets` and OAuth `google-drive`)
 * must produce identical spreadsheet views for the same API data.
 */

const { sheetsGetMock, valuesGetMock } = vi.hoisted(() => ({
  sheetsGetMock: vi.fn(),
  valuesGetMock: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: vi.fn() },
    drive: vi.fn(() => ({ files: { list: vi.fn() } })),
    sheets: vi.fn(() => ({
      spreadsheets: { get: sheetsGetMock, values: { get: valuesGetMock } },
    })),
  },
}));

interface ApiData {
  meta?: unknown;
  /** Values API responses keyed by requested A1 range. */
  values: Record<string, unknown>;
}

interface Transport {
  name: string;
  run(
    op: "inspect" | "readSheet" | "readRange",
    params: never,
    data: ApiData,
  ): Promise<{ result: unknown; ranges: string[] }>;
}

const serviceAccount: Transport = {
  name: "gsheets",
  async run(op, params, data) {
    sheetsGetMock.mockResolvedValue({ data: data.meta });
    valuesGetMock.mockImplementation(async ({ range }: { range: string }) => ({
      data: data.values[range] ?? {},
    }));
    const client = new GSheetsClient({ serviceAccountJson: "{}", timeoutMs: 1000 });
    const result =
      op === "inspect"
        ? await client.inspectSpreadsheet(params)
        : op === "readSheet"
          ? await client.readSheet(params)
          : await client.readRange(params);
    return { result, ranges: valuesGetMock.mock.calls.map(([args]) => args.range) };
  },
};

const drive: Transport = {
  name: "google-drive",
  async run(op, params, data) {
    const ranges: string[] = [];
    const fetchMock = vi.fn<DriveFetch>(async (input) => {
      const url = new URL(String(input));
      const match = url.pathname.match(/\/values\/(.+)$/);
      if (!match) return Response.json(data.meta);
      const range = decodeURIComponent(match[1]);
      ranges.push(range);
      return Response.json(data.values[range] ?? {});
    });
    const client = new GoogleDriveClient("token", fetchMock);
    const result =
      op === "inspect"
        ? await client.sheetsInspect(params)
        : op === "readSheet"
          ? await client.sheetsReadSheet(params)
          : await client.sheetsReadRange(params);
    return { result, ranges };
  },
};

const URL_S1 = "https://docs.google.com/spreadsheets/d/s1";

interface Case {
  name: string;
  op: "inspect" | "readSheet" | "readRange";
  params: Record<string, unknown>;
  data: ApiData;
  ranges: string[];
  expected: unknown;
}

const cases: Case[] = [
  {
    name: "empty tab with a quoted name",
    op: "readSheet",
    params: { spreadsheetId: "s1", tabName: "O'Brien Q1", headerRowIndex: 0, rowOffset: 0 },
    data: { values: { "'O''Brien Q1'": {} } },
    ranges: ["'O''Brien Q1'"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetUrl: URL_S1,
      tabName: "O'Brien Q1",
      headerRowIndex: null,
      headers: [],
      rows: [],
    },
  },
  {
    name: "auto-detected header below a title row, mixed primitive cells, URL ref",
    op: "readSheet",
    params: {
      spreadsheetUrl: `${URL_S1}/edit#gid=0`,
      tabName: "Clients",
      headerRowIndex: 0,
      rowOffset: 0,
    },
    data: {
      values: {
        "'Clients'": {
          values: [["Report"], ["", ""], ["Company", "MRR", "Active", ""], ["Acme", 10, true], ["Globex", null]],
        },
      },
    },
    ranges: ["'Clients'"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetUrl: URL_S1,
      tabName: "Clients",
      headerRowIndex: 3,
      headers: ["Company", "MRR", "Active"],
      rows: [
        { Company: "Acme", MRR: "10", Active: "true" },
        { Company: "Globex", MRR: "", Active: "" },
      ],
      rowOffset: 0,
      rowCount: 2,
      totalRowCount: 2,
    },
  },
  {
    name: "explicit header row with offset, limit and missing columns",
    op: "readSheet",
    params: {
      spreadsheetId: "  s1  ",
      tabName: "Clients",
      headerRowIndex: 2,
      rowOffset: 1,
      maxRows: 1,
      columns: ["Plan", "Name", "Missing"],
    },
    data: {
      values: {
        "'Clients'": {
          values: [["junk", "x"], ["Name", "Email", "Plan"], ["A", "a@x", "pro"], ["B", "b@x"], ["C", "c@x", "free"]],
        },
      },
    },
    ranges: ["'Clients'"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetUrl: URL_S1,
      tabName: "Clients",
      headerRowIndex: 2,
      headers: ["Plan", "Name"],
      rows: [{ Plan: "", Name: "B" }],
      rowOffset: 1,
      rowCount: 1,
      totalRowCount: 3,
      requestedColumns: ["Plan", "Name", "Missing"],
      missingColumns: ["Missing"],
    },
  },
  {
    name: "no detectable header row",
    op: "readSheet",
    params: { spreadsheetId: "s1", tabName: "Notes", headerRowIndex: 0, rowOffset: 0 },
    data: { values: { "'Notes'": { values: [["only"], ["one"]] } } },
    ranges: ["'Notes'"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetUrl: URL_S1,
      tabName: "Notes",
      headerRowIndex: null,
      headers: [],
      rows: [{}],
      rowOffset: 0,
      rowCount: 1,
      totalRowCount: 1,
    },
  },
  {
    name: "inspect with quoted, blank and untitled tabs",
    op: "inspect",
    params: { spreadsheetId: "s1", maxHeaderScanRows: 2 },
    data: {
      meta: {
        properties: { title: "Book" },
        sheets: [
          { properties: { sheetId: 1, title: "O'Brien", index: 0, gridProperties: { rowCount: 10, columnCount: 3 } } },
          { properties: { sheetId: 2, title: "Blank", index: 1 } },
          { properties: {} },
        ],
      },
      values: {
        "'O''Brien'!1:2": { values: [["Name", "Email"], ["A", "a@x"]] },
        "'Blank'!1:2": { values: [["", " "]] },
      },
    },
    ranges: ["'O''Brien'!1:2", "'Blank'!1:2"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetTitle: "Book",
      spreadsheetUrl: URL_S1,
      tabs: [
        {
          tabName: "O'Brien",
          sheetId: 1,
          index: 0,
          rowCount: 10,
          columnCount: 3,
          headers: ["Name", "Email"],
          headerRowIndex: 1,
          isEmpty: false,
        },
        {
          tabName: "Blank",
          sheetId: 2,
          index: 1,
          rowCount: null,
          columnCount: null,
          headers: [],
          headerRowIndex: null,
          isEmpty: true,
        },
        {
          tabName: "",
          sheetId: null,
          index: null,
          rowCount: null,
          columnCount: null,
          headers: [],
          headerRowIndex: null,
          isEmpty: true,
        },
      ],
    },
  },
  {
    name: "raw range falls back to requested range and dimension",
    op: "readRange",
    params: { spreadsheetId: "s1", range: "Clients!A1:B2", majorDimension: "COLUMNS" },
    data: { values: { "Clients!A1:B2": { values: [[1, null], "bad"] } } },
    ranges: ["Clients!A1:B2"],
    expected: {
      spreadsheetId: "s1",
      spreadsheetUrl: URL_S1,
      range: "Clients!A1:B2",
      majorDimension: "COLUMNS",
      values: [["1", ""], []],
    },
  },
];

describe.each([serviceAccount, drive])("$name Sheets views", (transport) => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(cases)("$name", async ({ op, params, data, ranges, expected }) => {
    const actual = await transport.run(op, params as never, data);
    // Compare serialized output: key order and omitted fields are what the model sees.
    expect(JSON.stringify(actual.result)).toBe(JSON.stringify(expected));
    expect(actual.ranges).toEqual(ranges);
  });

  it("rejects a missing spreadsheet reference", async () => {
    await expect(
      transport.run("readSheet", { spreadsheetUrl: "https://example.com/nope", tabName: "x" } as never, { values: {} }),
    ).rejects.toThrow("Provide spreadsheetId or a valid spreadsheetUrl.");
  });
});
