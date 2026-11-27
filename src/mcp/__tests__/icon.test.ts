import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIconResolver, normalizeServerIcon } from "../icon.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
      `data:image/png;base64,${"A".repeat(65536)}`,
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
    const icon = `data:image/svg+xml,<svg><text>${"界".repeat(16000)}</text></svg>`;
    expect(normalizeServerIcon(icon, "https://example.test/mcp")).toBe(icon);
    expect(normalizeServerIcon(`data:image/svg+xml,<svg><text>${"界".repeat(24000)}</text></svg>`,
      "https://example.test/mcp")).toBeUndefined();
  });
});

describe("createIconResolver", () => {
  it("refreshes a memoized miss and a cached hit while keeping the old icon on a later miss", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-refresh-"));
    let html = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/")) return response(url, "text/html", html);
      if (url.endsWith("/first.png")) return new Response("one", { headers: { "content-type": "image/png" } });
      if (url.endsWith("/second.png")) return new Response("two", { headers: { "content-type": "image/png" } });
      return new Response(null, { status: 404 });
    }));
    const resolve = createIconResolver(dir);
    await expect(resolve("https://example.test/mcp")).resolves.toBeUndefined();
    html = '<link rel="icon" href="/first.png">';
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBe("data:image/png;base64,b25l");
    html = '<link rel="icon" href="/second.png">';
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBe("data:image/png;base64,dHdv");
    html = "";
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBeUndefined();
    await expect(createIconResolver(dir)("https://example.test/mcp")).resolves.toBe("data:image/png;base64,dHdv");
  });

  it("replaces a legacy cache hit using root-domain discovery and reads it after restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    const file = path.join(dir, "mcp", "icons.json");
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify({ "api.example.test": "https://icons.test/old.png" }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://example.test/") return response(url, "text/html", `<link rel="icon" href="/static/icon.gif">`);
      if (url === "https://example.test/static/icon.gif") return new Response("GIF89a", { headers: { "content-type": "image/gif" } });
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createIconResolver(dir);
    expect(resolve.cached("https://api.example.test/mcp")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(resolve("https://api.example.test/mcp")).resolves.toBe("data:image/gif;base64,R0lGODlh");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "api.example.test": "data:image/gif;base64,R0lGODlh" });

    fetchMock.mockClear();
    await expect(createIconResolver(dir)("https://api.example.test/other")).resolves.toBe("data:image/gif;base64,R0lGODlh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the refreshed icon when an earlier cache migration finishes later", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    const file = path.join(dir, "mcp", "icons.json");
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify({ "example.test": "https://icons.test/legacy.gif" }));
    let icon = "https://icons.test/first.gif";
    let completeFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { completeFirst = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://icons.test/first.gif") return firstResponse;
      if (url === "https://icons.test/current.gif") return new Response("GIF89a", { headers: { "content-type": "image/gif" } });
      return response(url, "text/html", `<link rel="icon" href="${icon}">`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createIconResolver(dir);
    const migration = resolve("https://example.test/mcp");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://icons.test/first.gif", expect.anything()));

    icon = "https://icons.test/current.gif";
    await expect(resolve.refresh("https://example.test/mcp")).resolves.toBe("data:image/gif;base64,R0lGODlh");
    completeFirst(new Response("GIF87a", { headers: { "content-type": "image/gif" } }));
    await migration;

    expect(createIconResolver(dir).cached("https://example.test/mcp")).toBe("data:image/gif;base64,R0lGODlh");
  });

  it("uses the server host favicon when available", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/favicon.ico")
      ? new Response(new Uint8Array([0, 0, 1, 0]), { headers: { "content-type": "image/x-icon" } })
      : new Response(null, { status: 404 })));
    await expect(createIconResolver(dir)("https://mcp.example.test/mcp")).resolves.toBe("data:image/x-icon;base64,AAABAA==");
  });

  it("times out a stalled icon download while another lookup completes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://icons.test/slow.gif") return new Promise<Response>(() => {});
      if (url === "https://icons.test/fast.gif") return new Response("GIF89a", { headers: { "content-type": "image/gif" } });
      const speed = url.startsWith("https://slow.test/") ? "slow" : "fast";
      return response(url, "text/html", `<link rel="icon" href="https://icons.test/${speed}.gif">`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createIconResolver(dir);
    const slow = resolve("https://slow.test/mcp");
    await expect(resolve("https://fast.test/mcp")).resolves.toBe("data:image/gif;base64,R0lGODlh");
    expect(fetchMock).toHaveBeenCalledWith("https://icons.test/slow.gif", expect.anything());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(slow).resolves.toBeUndefined();
  });

  it.each([
    ["text/html", "<p>Website</p>"],
    ["image/svg+xml", "<svg><script/></svg>"],
    ["image/svg+xml", '<svg onload=""/>'],
    ["image/png", "A".repeat(49_152)],
  ])("drops an unusable %s response", async (type, body) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "https://icons.test/logo"
      ? new Response(body, { headers: { "content-type": type } })
      : response(url, "text/html", '<link rel="icon" href="https://icons.test/logo">')));
    await expect(createIconResolver(dir)("https://example.test/mcp")).resolves.toBeUndefined();
  });

  it.each(["localhost", "asset.localhost.", "asset.local", "127.0.0.1", "10.0.0.2", "169.254.1.1", "[fd00::1]"])(
    "does not request a website icon from %s, including after a redirect",
    async (host) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
      let icon = `http://${host}/icon.png`;
      const fetchMock = vi.fn(async (url: string) => url === "https://icons.test/logo"
        ? new Response(null, { status: 302, headers: { location: `http://${host}/icon.png` } })
        : response(url, "text/html", `<link rel="icon" href="${icon}">`));
      vi.stubGlobal("fetch", fetchMock);
      const resolve = createIconResolver(dir);
      await expect(resolve("https://example.test/mcp")).resolves.toBeUndefined();
      icon = "https://icons.test/logo";
      await expect(resolve.refresh("https://example.test/mcp")).resolves.toBeUndefined();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://example.test/", "https://example.test/favicon.ico",
        "https://example.test/", "https://example.test/favicon.ico", "https://icons.test/logo",
      ]);
    },
  );

  it("survives a failing page body read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-icon-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/")
      ? { ok: true, url, headers: new Headers({ "content-type": "text/html" }), text: async () => { throw new Error("reset"); } }
      : { ok: false }));
    await expect(createIconResolver(dir)("https://mcp.example.com/mcp")).resolves.toBeUndefined();
  });
});
