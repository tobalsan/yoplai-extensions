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
