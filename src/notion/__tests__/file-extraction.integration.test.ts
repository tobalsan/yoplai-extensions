import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { NotionClient } from "../client.js";

describe("Notion file extraction integration", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())) ?? resolve());
  });

  it("downloads a signed URL intact and extracts a real text PDF with the bundled PDF.js parser", async () => {
    const signedQuery = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc%2Fdef&X-Amz-Security-Token=token";
    let receivedUrl = "";
    server = createServer((request, response) => {
      receivedUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(readFileSync(new URL("../../__tests__/fixtures/text.pdf", import.meta.url)));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/notion-cv.pdf?${signedQuery}`;
    const client = new NotionClient({ apiKey: "secret", notionVersion: "2025-09-03", timeoutMs: 12_345 });

    await expect(client.downloadAndExtractFile({ url })).resolves.toMatchObject({ text: "Orchard Observatory PDF sample", source: { url } });
    expect(receivedUrl).toBe(`/notion-cv.pdf?${signedQuery}`);
  });
});
