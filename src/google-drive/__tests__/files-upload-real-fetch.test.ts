// Runs the real global fetch, with npm undici loaded as in the gateway, against a local
// HTTP server. Stubbed fetch hides header problems that only the real stack exposes.
import "undici";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { GoogleDriveClient } from "../client.js";

interface Seen { method: string; url: string; contentLength: string | undefined; contentRange: string | undefined; bodyBytes: number }
type Reply = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function fakeDrive(reply: Reply) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const entry: Seen = { method: req.method!, url: req.url!, contentLength: req.headers["content-length"], contentRange: req.headers["content-range"], bodyBytes: 0 };
    seen.push(entry);
    req.on("data", (chunk: Buffer) => { entry.bodyBytes += chunk.length; });
    req.on("end", () => reply(req, res, entry));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Google's hosts are rewritten to the local server; the request itself goes through the real fetch.
  const client = new GoogleDriveClient("fake-token", (url, init) => fetch(String(url).replace("https://www.googleapis.com", origin), init));
  return { client, seen };
}

async function saveDeck(client: GoogleDriveClient, size: number) {
  const hostPath = await mkdtemp(path.join(tmpdir(), "drive-real-fetch-"));
  cleanups.push(() => rm(hostPath, { recursive: true, force: true }));
  await writeFile(path.join(hostPath, "deck.pptx"), Buffer.alloc(size, 5));
  return client.saveFile({ path: "deck.pptx", name: "Fake Deck", convert: true }, {
    agentId: "agent", sessionId: "session", userId: "user",
    conversationFiles: { hostPath, runtimePath: "/workspace/files" },
  });
}

const uploadedDeck = JSON.stringify({ id: "fake-deck-id", name: "Fake Deck", mimeType: "application/vnd.google-apps.presentation" });
const sessionLocation = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fake-session";

it("uploads a 6 MB file through the resumable path with a single numeric Content-Length", async () => {
  const { client, seen } = await fakeDrive((req, res) => {
    if (req.method === "POST") return res.writeHead(200, { Location: sessionLocation }).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(uploadedDeck);
  });

  await expect(saveDeck(client, 6_000_000)).resolves.toMatchObject({ fileId: "fake-deck-id" });

  const upload = seen.filter(request => request.method === "PUT");
  expect(upload).toEqual([expect.objectContaining({ contentLength: "6000000", bodyBytes: 6_000_000 })]);
});

it("recovers a dropped upload with an empty status query and resumes from the acknowledged byte", async () => {
  const { client, seen } = await fakeDrive((req, res, request) => {
    if (req.method === "POST") return res.writeHead(200, { Location: sessionLocation }).end();
    if (request.contentRange === undefined) return void req.socket.destroy();
    if (request.contentRange === "bytes */6000000") return res.writeHead(308, { Range: "bytes=0-999999" }).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(uploadedDeck);
  });

  await expect(saveDeck(client, 6_000_000)).resolves.toMatchObject({ fileId: "fake-deck-id" });

  const [, statusQuery, resume] = seen.filter(request => request.method === "PUT");
  expect(statusQuery).toMatchObject({ contentLength: "0", contentRange: "bytes */6000000", bodyBytes: 0 });
  expect(resume).toMatchObject({ contentLength: "5000000", contentRange: "bytes 1000000-5999999/6000000", bodyBytes: 5_000_000 });
});

it("keeps saving a 5 MB file in a single multipart request", async () => {
  const { client, seen } = await fakeDrive((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(uploadedDeck));

  await expect(saveDeck(client, 5_000_000)).resolves.toMatchObject({ fileId: "fake-deck-id" });

  expect(seen).toEqual([expect.objectContaining({ method: "POST", url: expect.stringContaining("uploadType=multipart") })]);
  expect(seen[0].bodyBytes).toBeGreaterThan(5_000_000);
});
