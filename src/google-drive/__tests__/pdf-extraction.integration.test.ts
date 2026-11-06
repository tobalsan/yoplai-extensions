import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { GoogleDriveClient } from "../client.js";

it("reads a PDF file as text using the real PDF.js parser", async () => {
  const pdf = readFileSync(new URL("../../__tests__/fixtures/text.pdf", import.meta.url));
  const client = new GoogleDriveClient("test-token", async (url) => {
    if (new URL(String(url)).searchParams.get("alt") === "media") {
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
    return Response.json({ id: "sample-pdf", name: "sample.pdf", mimeType: "application/pdf" });
  });

  await expect(client.readFile({ fileId: "sample-pdf" })).resolves.toMatchObject({
    text: "Orchard Observatory PDF sample",
  });
});
