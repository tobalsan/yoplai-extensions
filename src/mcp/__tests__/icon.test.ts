import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIconResolver } from "../icon.js";

afterEach(() => vi.unstubAllGlobals());

function response(url: string, contentType: string, body = "") {
  return { ok: true, url, headers: new Headers({ "content-type": contentType }), text: async () => body };
}

describe("createIconResolver", () => {
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
