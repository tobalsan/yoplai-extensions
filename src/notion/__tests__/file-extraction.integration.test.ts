import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { NotionClient } from "../client.js";

function textPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

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
      response.end(textPdf("Signed Notion CV"));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/notion-cv.pdf?${signedQuery}`;
    const client = new NotionClient({ apiKey: "secret", notionVersion: "2025-09-03", timeoutMs: 12_345 });

    await expect(client.downloadAndExtractFile({ url })).resolves.toMatchObject({ text: "Signed Notion CV", source: { url } });
    expect(receivedUrl).toBe(`/notion-cv.pdf?${signedQuery}`);
  });
});
