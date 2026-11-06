import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { checkPdfjsVersions } from "./pdfjs-versions.mjs";

const require = createRequire(import.meta.url);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const worker = await readFile(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8");
const workerVersion = worker.match(/const workerVersion = "([^"]+)"/)?.[1];

let gatewayVersion;
if (process.env.GATEWAY_ROOT) {
  try {
    const gatewayRequire = createRequire(resolve(process.env.GATEWAY_ROOT, "package.json"));
    const parserRequire = createRequire(gatewayRequire.resolve("pdf-parse"));
    gatewayVersion = JSON.parse(await readFile(parserRequire.resolve("pdfjs-dist/package.json"), "utf8")).version;
  } catch (error) {
    throw new Error("[pdfjs] Cannot determine the gateway PDF.js version from GATEWAY_ROOT; install the gateway dependencies first.", { cause: error });
  }
} else {
  gatewayVersion = process.env.GATEWAY_PDFJS_VERSION;
}

checkPdfjsVersions({ apiVersion: pdfjs.version, workerVersion, gatewayVersion });
console.log(`[pdfjs] PDF.js extensions/API/worker ${pdfjs.version}; gateway ${gatewayVersion} verified`);
