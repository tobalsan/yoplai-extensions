import { afterEach, describe, expect, it, vi } from "vitest";

import { GSheetsClient } from "../client.js";

const { driveFilesListMock, sheetsGetMock, valuesGetMock, valuesAppendMock, valuesUpdateMock, googleAuthMock } =
  vi.hoisted(() => ({
    driveFilesListMock: vi.fn(),
    sheetsGetMock: vi.fn(),
    valuesGetMock: vi.fn(),
    valuesAppendMock: vi.fn(),
    valuesUpdateMock: vi.fn(),
    googleAuthMock: vi.fn(),
  }));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: googleAuthMock,
    },
    drive: vi.fn(() => ({
      files: {
        list: driveFilesListMock,
      },
    })),
    sheets: vi.fn(() => ({
      spreadsheets: {
        get: sheetsGetMock,
        values: {
          get: valuesGetMock,
          append: valuesAppendMock,
          update: valuesUpdateMock,
        },
      },
    })),
  },
}));

function makeClient(): GSheetsClient {
  return new GSheetsClient({
    serviceAccountJson: JSON.stringify({
      client_email: "service@example.com",
      private_key: "private",
    }),
    timeoutMs: 30_000,
  });
}

describe("GSheetsClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists accessible spreadsheets and filters by name", async () => {
    driveFilesListMock.mockResolvedValue({
      data: {
        files: [
          {
            id: "sheet-1",
            name: "ARR MRR",
            modifiedTime: "2026-04-01T00:00:00.000Z",
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1",
          },
        ],
      },
    });

    const result = await makeClient().listSpreadsheets({
      query: "ARR",
      pageSize: 20,
      pageToken: "next-page",
    });

    expect(driveFilesListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 20,
        pageToken: "next-page",
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'ARR'",
      }),
      { timeout: 30_000 },
    );
    expect(result).toEqual({
      spreadsheets: [
        {
          id: "sheet-1",
          name: "ARR MRR",
          url: "https://docs.google.com/spreadsheets/d/sheet-1",
          lastModified: "2026-04-01T00:00:00.000Z",
        },
      ],
      nextPageToken: null,
    });
  });

  it("inspects tabs and detects headers", async () => {
    sheetsGetMock.mockResolvedValue({
      data: {
        properties: { title: "Revenue" },
        sheets: [
          {
            properties: {
              sheetId: 123,
              title: "2026-02",
              index: 0,
              gridProperties: { rowCount: 50, columnCount: 6 },
            },
          },
        ],
      },
    });
    valuesGetMock.mockResolvedValue({
      data: {
        values: [
          ["", ""],
          ["Company", "MRR", "ARR"],
          ["Acme", "10", "120"],
        ],
      },
    });

    const result = await makeClient().inspectSpreadsheet({
      spreadsheetId: "sheet-1",
      maxHeaderScanRows: 10,
    });

    expect(valuesGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-1",
        range: "'2026-02'!1:10",
      }),
      { timeout: 30_000 },
    );
    expect(result).toEqual({
      spreadsheetId: "sheet-1",
      spreadsheetTitle: "Revenue",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      tabs: [
        {
          tabName: "2026-02",
          sheetId: 123,
          index: 0,
          rowCount: 50,
          columnCount: 6,
          headers: ["Company", "MRR", "ARR"],
          headerRowIndex: 2,
          isEmpty: false,
        },
      ],
    });
  });

  it("reads a sheet as header-mapped rows", async () => {
    valuesGetMock.mockResolvedValue({
      data: {
        values: [
          ["Company", "MRR", "ARR"],
          ["Acme", "10", "120"],
          ["Globex", "20", "240"],
        ],
      },
    });

    const result = await makeClient().readSheet({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      tabName: "2026-02",
      headerRowIndex: 0,
      rowOffset: 0,
    });

    expect(valuesGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-1",
        range: "'2026-02'",
        majorDimension: "ROWS",
      }),
      { timeout: 30_000 },
    );
    expect(result).toMatchObject({
      spreadsheetId: "sheet-1",
      tabName: "2026-02",
      headerRowIndex: 1,
      headers: ["Company", "MRR", "ARR"],
      rows: [
        { Company: "Acme", MRR: "10", ARR: "120" },
        { Company: "Globex", MRR: "20", ARR: "240" },
      ],
    });
  });

  it("reads a projected page of sheet rows", async () => {
    valuesGetMock.mockResolvedValue({
      data: {
        values: [
          ["Company", "MRR", "ARR"],
          ["Acme", "10", "120"],
          ["Globex", "20", "240"],
          ["Initech", "30", "360"],
        ],
      },
    });

    const result = await makeClient().readSheet({
      spreadsheetId: "sheet-1",
      tabName: "2026-02",
      headerRowIndex: 0,
      rowOffset: 1,
      maxRows: 1,
      columns: ["Company", "ARR", "Missing"],
    });

    expect(result).toMatchObject({
      headers: ["Company", "ARR"],
      rowOffset: 1,
      rowCount: 1,
      totalRowCount: 3,
      requestedColumns: ["Company", "ARR", "Missing"],
      missingColumns: ["Missing"],
      rows: [{ Company: "Globex", ARR: "240" }],
    });
  });

  it("reads raw ranges", async () => {
    valuesGetMock.mockResolvedValue({
      data: {
        range: "Sheet1!A1:B2",
        majorDimension: "ROWS",
        values: [["A", "B"]],
      },
    });

    const result = await makeClient().readRange({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
      majorDimension: "ROWS",
    });

    expect(valuesGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-1",
        range: "Sheet1!A1:B2",
        majorDimension: "ROWS",
      }),
      { timeout: 30_000 },
    );
    expect(result).toEqual({
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      range: "Sheet1!A1:B2",
      majorDimension: "ROWS",
      values: [["A", "B"]],
    });
  });

  it("appends rows after existing table data", async () => {
    valuesAppendMock.mockResolvedValue({
      data: {
        updates: {
          updatedRange: "Sheet1!A4:B4",
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        },
      },
    });

    const result = await makeClient().appendRows({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A:B",
      values: [["Acme", "10"]],
      valueInputOption: "USER_ENTERED",
    });

    expect(valuesAppendMock).toHaveBeenCalledWith(
      {
        spreadsheetId: "sheet-1",
        range: "Sheet1!A:B",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [["Acme", "10"]] },
      },
      { timeout: 30_000 },
    );
    expect(result).toEqual({
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      updatedRange: "Sheet1!A4:B4",
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
  });

  it("updates an exact range", async () => {
    valuesUpdateMock.mockResolvedValue({
      data: {
        updatedRange: "Sheet1!A1:B1",
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      },
    });

    const result = await makeClient().updateRange({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B1",
      values: [["Company", "MRR"]],
      valueInputOption: "RAW",
    });

    expect(valuesUpdateMock).toHaveBeenCalledWith(
      {
        spreadsheetId: "sheet-1",
        range: "Sheet1!A1:B1",
        valueInputOption: "RAW",
        requestBody: { values: [["Company", "MRR"]] },
      },
      { timeout: 30_000 },
    );
    expect(result).toEqual({
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      updatedRange: "Sheet1!A1:B1",
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
  });

  it("parses service account JSON without exposing the raw secret", async () => {
    expect(() => makeClient()).not.toThrow();
    expect(googleAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          client_email: "service@example.com",
          private_key: "private",
        },
      }),
    );
  });

  it("reports invalid service account JSON without echoing it", () => {
    expect(
      () =>
        new GSheetsClient({
          serviceAccountJson: "{\"private_key\":\"secret\"",
          timeoutMs: 30_000,
        }),
    ).toThrow("Invalid Google service account JSON.");
  });
});
