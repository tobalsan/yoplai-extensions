import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIconResolver, normalizeServerIcon } from "../icon.js";

afterEach(() => vi.unstubAllGlobals());

function response(url: string, contentType: string, body = "") {
  return { ok: true, url, headers: new Headers({ "content-type": contentType }), text: async () => body };
}

describe("normalizeServerIcon", () => {
  it("chooses a light allowed image ahead of dark and unspecified MIME icons", () => {
    expect(normalizeServerIcon([
      { src: "/dark.png", theme: "dark", mimeType: "image/png" },
      { src: "/unknown" },
      { src: "../light.png", theme: "light", mimeType: "image/png" },
    ], "https://example.test/mcp/server")).toBe("https://example.test/light.png");
  });

  it("accepts small allowed embedded images and both SVG encodings", () => {
    for (const uri of [
      "data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/", "data:image/gif;base64,R0lGODlh",
      "data:image/webp;base64,UklGRg==", "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
      "data:image/svg+xml;base64,PHN2Zy8+",
    ]) expect(normalizeServerIcon(uri, "https://example.test/mcp")).toBe(uri);
  });

  it("ignores malformed, oversized, non-image, and scriptable embedded icons", () => {
    for (const uri of [
      "data:text/html;base64,PHN2Zy8+", "data:image/png,plain", "data:image/png;base64,%%%",
      `data:image/png;base64,${"A".repeat(32768)}`,
      "data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%2F%3E",
      "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,%3Csvg%3E%3CforeignObject%2F%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,%3Csvg%3E%3Ca%20href%3D%22java%26%23x73%3Bcript%3Aalert(1)%22%2F%3E%3C%2Fsvg%3E",
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+",
      "data:image/svg+xml,%ZZ", `https://example.test/${"x".repeat(2048)}`, "javascript:alert(1)",
    ]) expect(normalizeServerIcon(uri, "https://example.test/mcp")).toBeUndefined();
  });

  it("rejects SVG javascript URLs obscured by named whitespace entities", () => {
    expect(normalizeServerIcon("data:image/svg+xml,%3Csvg%3E%3Ca%20href%3D%22java%26Tab%3Bscript%3Aalert(1)%22%2F%3E%3C%2Fsvg%3E",
      "https://example.test/mcp")).toBeUndefined();
  });

  it("limits the full data URI by UTF-8 bytes rather than Unicode character count", () => {
    expect(normalizeServerIcon(`data:image/svg+xml,<svg><text>${"界".repeat(12000)}</text></svg>`,
      "https://example.test/mcp")).toBeUndefined();
  });
});

describe("createIconResolver", () => {
  it("refreshes a memoized miss and a cached hit while keeping the old icon on a later miss", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-refresh-"));
    let html = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/")
      ? response(url, "text/html", html) : { ok: false }));
    const resolve = createIconResolver(dir);
    await expect(resolve("https://example.test/mcp")).resolves.toBeUndefined();
    html = '<link rel="icon" href="/first.png">';
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBe("https://example.test/first.png");
    html = '<link rel="icon" href="/second.png">';
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBe("https://example.test/second.png");
    html = "";
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBeUndefined();
    await expect(createIconResolver(dir)("https://example.test/mcp")).resolves.toBe("https://example.test/second.png");
  });

  it("falls back to the root domain and persists the icon map", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://claap.io/") return response(url, "text/html", `<link rel="icon" href="/static/icon.png">`);
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createIconResolver(dir);
    await expect(resolve("https://api.claap.io/mcp")).resolves.toBe("https://claap.io/static/icon.png");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining(["https://api.claap.io/", "https://claap.io/"]));
    expect(JSON.parse(await fs.readFile(path.join(dir, "mcp", "icons.json"), "utf8"))).toEqual({ "api.claap.io": "https://claap.io/static/icon.png" });

    fetchMock.mockClear();
    await expect(createIconResolver(dir)("https://api.claap.io/other")).resolves.toBe("https://claap.io/static/icon.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the server host favicon when available", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/favicon.ico") ? response(url, "image/x-icon") : { ok: false }));
    await expect(createIconResolver(dir)("https://mcp.example.com/mcp")).resolves.toBe("https://mcp.example.com/favicon.ico");
  });

  it("survives a failing page body read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/")
      ? { ok: true, url, headers: new Headers({ "content-type": "text/html" }), text: async () => { throw new Error("reset"); } }
      : { ok: false }));
    await expect(createIconResolver(dir)("https://mcp.example.com/mcp")).resolves.toBeUndefined();
  });
});
