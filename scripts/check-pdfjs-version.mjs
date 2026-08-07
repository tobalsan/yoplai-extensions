import { readFile } from "node:fs/promises";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const worker = await readFile(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), "utf8");
const workerVersion = worker.match(/const workerVersion = "([^"]+)"/)?.[1];

if (!workerVersion || workerVersion !== pdfjs.version) {
  throw new Error(
    `[notion] PDF.js API/worker version mismatch: API ${pdfjs.version}; worker ${workerVersion ?? "unknown"}. Reinstall dependencies before deploying.`,
  );
}

console.log(`[notion] PDF.js API/worker version ${pdfjs.version} verified`);
