import { afterEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveClient, type DriveFetch } from "../client.js";

const { mammothExtractRawTextMock } = vi.hoisted(() => ({
  mammothExtractRawTextMock: vi.fn(),
}));

vi.mock("mammoth", () => ({
  __esModule: true,
  default: {
    extractRawText: mammothExtractRawTextMock,
  },
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: DriveFetch): GoogleDriveClient {
  return new GoogleDriveClient("fresh-access-token", fetchImpl);
}

describe("GoogleDriveClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mammothExtractRawTextMock.mockReset();
  });

  it("lists files with a name filter, pagination, and a bearer token", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(
      jsonResponse({
        files: [
          {
            id: "file-1",
            name: "Q1 Report",
            mimeType: "application/pdf",
            modifiedTime: "2026-04-01T00:00:00.000Z",
            size: "2048",
            webViewLink: "https://drive.google.com/file/d/file-1/view",
          },
        ],
        nextPageToken: "next-page",
      }),
    );

    const result = await makeClient(fetchMock).listFiles({
      query: "Report",
      pageSize: 20,
    });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(calledUrl));
    expect(url.pathname).toBe("/drive/v3/files");
    expect(url.searchParams.get("q")).toBe("trashed=false and name contains 'Report'");
    expect(url.searchParams.get("pageSize")).toBe("20");
    expect(url.searchParams.get("spaces")).toBe("drive");
    expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-access-token",
    );

    expect(result).toEqual({
      files: [
        {
          id: "file-1",
          name: "Q1 Report",
          mimeType: "application/pdf",
          modifiedTime: "2026-04-01T00:00:00.000Z",
          size: 2048,
          webViewLink: "https://drive.google.com/file/d/file-1/view",
        },
      ],
      nextPageToken: "next-page",
    });
  });

  it("lists files without a filter and forwards the page token", async () => {
    const fetchMock = vi
      .fn<DriveFetch>()
      .mockResolvedValue(jsonResponse({ files: [], nextPageToken: null }));

    const result = await makeClient(fetchMock).listFiles({
      pageSize: 50,
      pageToken: "token-abc",
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("trashed=false");
    expect(url.searchParams.get("pageToken")).toBe("token-abc");
    expect(result).toEqual({ files: [], nextPageToken: null });
  });

  it("searches with a raw Drive query", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(
      jsonResponse({
        files: [
          { id: "file-9", name: "Deck", mimeType: "application/vnd.google-apps.presentation" },
        ],
      }),
    );

    const result = await makeClient(fetchMock).searchFiles({
      query: "name contains 'Deck' and mimeType='application/vnd.google-apps.presentation'",
      pageSize: 50,
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe(
      "name contains 'Deck' and mimeType='application/vnd.google-apps.presentation'",
    );
    expect(result).toEqual({
      files: [
        {
          id: "file-9",
          name: "Deck",
          mimeType: "application/vnd.google-apps.presentation",
          modifiedTime: null,
          size: null,
          webViewLink: null,
        },
      ],
      nextPageToken: null,
    });
  });

  it("reads a plain text file via the media endpoint", async () => {
    const fetchMock = vi
      .fn<DriveFetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: "file-2", name: "notes.txt", mimeType: "text/plain" }),
      )
      .mockResolvedValueOnce(new Response("Hello  \r\nWorld", { status: 200 }));

    const result = await makeClient(fetchMock).readFile({ fileId: "file-2" });

    const metaUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(metaUrl.pathname).toBe("/drive/v3/files/file-2");
    expect(metaUrl.searchParams.get("fields")).toBe("id,name,mimeType");

    const mediaUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(mediaUrl.pathname).toBe("/drive/v3/files/file-2");
    expect(mediaUrl.searchParams.get("alt")).toBe("media");

    expect(result).toEqual({
      fileId: "file-2",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "Hello\nWorld",
      bytes: 14,
      exported: false,
    });
  });

  it("exports Google Docs to plain text via the export endpoint", async () => {
    const fetchMock = vi
      .fn<DriveFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "doc-1",
          name: "Strategy",
          mimeType: "application/vnd.google-apps.document",
        }),
      )
      .mockResolvedValueOnce(new Response("Exported doc body", { status: 200 }));

    const result = await makeClient(fetchMock).readFile({ fileId: "doc-1" });

    const exportUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(exportUrl.pathname).toBe("/drive/v3/files/doc-1/export");
    expect(exportUrl.searchParams.get("mimeType")).toBe("text/plain");

    expect(result).toMatchObject({
      fileId: "doc-1",
      name: "Strategy",
      text: "Exported doc body",
      exported: true,
    });
  });

  it("extracts DOCX text via mammoth", async () => {
    mammothExtractRawTextMock.mockResolvedValue({ value: "Resume text" });
    const fetchMock = vi
      .fn<DriveFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "file-3",
          name: "cv.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      )
      .mockResolvedValueOnce(new Response("PKbinary", { status: 200 }));

    const result = await makeClient(fetchMock).readFile({ fileId: "file-3" });

    expect(mammothExtractRawTextMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ name: "cv.docx", text: "Resume text", exported: false });
  });

  it("surfaces a clean error (not a raw response) on HTTP failure", async () => {
    const fetchMock = vi
      .fn<DriveFetch>()
      .mockResolvedValue(new Response("nope", { status: 403 }));

    await expect(makeClient(fetchMock).listFiles({ pageSize: 50 })).rejects.toThrow(
      /Google Drive request failed \(HTTP 403\)/,
    );
  });
});

describe("GoogleDriveClient writes", () => {
  it("creates folders with optional parents", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(jsonResponse({ id: "folder" }));
    await expect(makeClient(fetchMock).createFolder({ name: "Clients", parentId: "parent" })).resolves.toEqual({ id: "folder" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/files");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Clients", mimeType: "application/vnd.google-apps.folder", parents: ["parent"] });
  });

  it.each([undefined, "doc", "sheet"] as const)("creates multipart files with conversion %s", async (convertTo) => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(jsonResponse({ id: "file" }));
    await makeClient(fetchMock).createFile({ name: "Clients", content: "name,value\nAlice,1", parentId: "parent", convertTo });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("uploadType=multipart");
    expect(init?.method).toBe("POST");
    const contentType = (init?.headers as Record<string, string>)["Content-Type"];
    const boundary = contentType.split("boundary=")[1];
    expect(String(init?.body)).toContain(`--${boundary}\r\n`);
    expect(String(init?.body)).toContain('"parents":["parent"]');
    expect(String(init?.body)).toContain("name,value\nAlice,1");
    expect(String(init?.body)).toContain(convertTo === "doc" ? "application/vnd.google-apps.document" : convertTo === "sheet" ? "application/vnd.google-apps.spreadsheet" : "text/plain");
  });

  it.each([
    ["application/vnd.google-apps.document", "text/plain"],
    ["application/vnd.google-apps.spreadsheet", "text/csv"],
    ["text/csv", "text/csv"],
  ])("overwrites %s using %s media", async (mimeType, uploadMime) => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValueOnce(jsonResponse({ name: "Clients", mimeType })).mockResolvedValueOnce(jsonResponse({ id: "file/1" }));
    await makeClient(fetchMock).updateFileContent({ fileId: "file/1", content: "replacement" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://www.googleapis.com/upload/drive/v3/files/file%2F1?uploadType=media");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe("replacement");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(uploadMime);
  });

  it("renames and moves with Drive parent query parameters", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(jsonResponse({ id: "file" }));
    await makeClient(fetchMock).renameMoveFile({ fileId: "file", name: "New name", addParentId: "new", removeParentId: "old" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("addParents")).toBe("new");
    expect(new URL(String(url)).searchParams.get("removeParents")).toBe("old");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "New name" });
    await expect(makeClient(fetchMock).renameMoveFile({ fileId: "file" })).rejects.toThrow("Provide a name or parent change");
  });

  it.each([false, true])("writes Sheets values (append=%s) with encoded A1 ranges", async (append) => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValue(jsonResponse({ updatedCells: 3 }));
    const client = makeClient(fetchMock);
    const params = { spreadsheetId: "sheet/id", range: "'Client DB'!A2:C", values: [["Alice", 1, true]] };
    if (append) await client.sheetsAppendRows({ ...params, rows: params.values });
    else await client.sheetsUpdateRange(params);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(calledUrl));
    expect(url.hostname).toBe("sheets.googleapis.com");
    expect(url.pathname).toContain("sheet%2Fid/values/");
    expect(decodeURIComponent(url.pathname)).toContain("'Client DB'!A2:C");
    expect(url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(url.searchParams.get("insertDataOption")).toBe(append ? "INSERT_ROWS" : null);
    expect(init?.method).toBe(append ? "POST" : "PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ range: params.range, majorDimension: "ROWS", values: params.values });
  });

  it("retries 429 responses and stops after two retries", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockImplementation(async () => new Response("rate limit", { status: 429, headers: { "retry-after": "0" } }));
    await expect(makeClient(fetchMock).createFolder({ name: "Clients" })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("continues after a rate limit without replaying non-429 errors", async () => {
    const fetchMock = vi.fn<DriveFetch>().mockResolvedValueOnce(new Response("rate limit", { status: 429, headers: { "retry-after": "0" } })).mockResolvedValueOnce(jsonResponse({ id: "folder" }));
    await expect(makeClient(fetchMock).createFolder({ name: "Clients" })).resolves.toEqual({ id: "folder" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const denied = vi.fn<DriveFetch>().mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(makeClient(denied).createFolder({ name: "Clients" })).rejects.toMatchObject({ status: 403 });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});


describe("GoogleDriveClient request timeout", () => {
  it("aborts a hanging write and allows the next request to progress", async () => {
    vi.useFakeTimers();
    // Keep timeout timers controllable across Node versions.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const fetchMock = vi.fn<DriveFetch>().mockImplementationOnce(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }).mockResolvedValueOnce(jsonResponse({ id: "folder" }));
    try {
      const client = makeClient(fetchMock);
      const assertion = expect(client.createFolder({ name: "Clients" })).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      await expect(client.createFolder({ name: "Retry after checking Drive" })).resolves.toEqual({ id: "folder" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
