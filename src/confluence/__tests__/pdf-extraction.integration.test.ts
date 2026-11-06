import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { ConfluenceClient } from "../client.js";

it("downloads a PDF and extracts text using the real PDF.js parser", async () => {
  const pdf = readFileSync(new URL("../../__tests__/fixtures/text.pdf", import.meta.url));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(pdf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const client = new ConfluenceClient({
      subdomain: "example", email: "test@example.com", apiToken: "test-token", timeoutMs: 1000,
    });

    await expect(client.downloadAndExtractFile({
      url: `http://127.0.0.1:${address.port}/sample.pdf`,
    })).resolves.toMatchObject({ text: "Orchard Observatory PDF sample" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
