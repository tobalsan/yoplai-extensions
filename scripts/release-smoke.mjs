import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extract } from "tar";

const releaseDir = resolve("release");
const expectedText = "Orchard Observatory PDF sample";
const hooks = ["start", "stop", "registerRoutes", "validateConfig", "capabilities"];

async function loadArchives(scratch) {
  const assets = (await readdir(releaseDir)).filter(name => name.endsWith(".tgz")).sort();
  const catalog = JSON.parse(await readFile(join(releaseDir, "catalog.json"), "utf8"));
  const bundles = new Map();
  for (const asset of assets) {
    const folder = join(scratch, asset);
    await mkdir(folder);
    await extract({ file: join(releaseDir, asset), cwd: folder, strict: true });
    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    assert.equal(asset, `${manifest.id}-${manifest.version}.tgz`);
    assert.equal(manifest.entry, "index.js");
    const entryUrl = pathToFileURL(join(folder, manifest.entry));
    entryUrl.searchParams.set("v", `smoke-${manifest.id}`);
    const extension = (await import(entryUrl.href)).default;
    assert.equal(extension.id, manifest.id);
    for (const hook of hooks) assert.equal(typeof extension[hook], "function", `${manifest.id}.${hook}`);
    bundles.set(manifest.id, { extension, entryUrl });
  }
  for (const { id } of catalog.extensions) assert(bundles.has(id), `Missing archive for ${id}.`);
  return bundles;
}

function tool(bundle, config, name) {
  const selected = bundle.extension.createTools(config).find(candidate => candidate.name === name);
  assert(selected, `Missing tool: ${bundle.extension.id}.${name}`);
  return selected.execute;
}

async function checkPdf(bundle, read, previous) {
  assert.equal((await read()).text, expectedText);
  const used = globalThis.pdfjsWorker?.WorkerMessageHandler;
  assert(used, `Missing PDF.js worker for ${bundle.extension.id}.`);
  assert.notEqual(used, previous, `PDF.js reused a worker in ${bundle.extension.id}.`);
  const workerUrl = new URL("./pdf.worker.mjs", bundle.entryUrl);
  workerUrl.search = bundle.entryUrl.search;
  const { WorkerMessageHandler } = await import(workerUrl.href);
  assert.equal(used, WorkerMessageHandler, `PDF.js did not load the versioned worker for ${bundle.extension.id}.`);
  return used;
}

async function checkTools(bundles, scratch) {
  const drive = bundles.get("googleDrive");
  const confluence = bundles.get("confluence");
  assert(drive && confluence, "The PDF smoke test needs Drive and Confluence.");
  const pdf = await readFile(new URL("../src/__tests__/fixtures/text.pdf", import.meta.url));
  const deck = join(scratch, "smoke.pptx");
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.pdfjsWorker;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.href === "https://fixture.atlassian.net/sample.pdf" ||
        (url.pathname === "/drive/v3/files/sample-pdf" && url.searchParams.get("alt") === "media")) {
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
    if (url.pathname === "/drive/v3/files/sample-pdf") {
      return Response.json({ id: "sample-pdf", name: "sample.pdf", mimeType: "application/pdf" });
    }
    if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart") {
      const body = Buffer.from(init.body);
      const start = body.indexOf("PK\x03\x04");
      const end = body.lastIndexOf("\r\n--");
      assert(start >= 0 && end > start, "The upload did not contain a PowerPoint file.");
      await writeFile(deck, body.subarray(start, end));
      return Response.json({ id: "smoke-deck" });
    }
    if (url.href === "https://slides.googleapis.com/v1/presentations/smoke-deck") {
      return Response.json({ presentationId: "smoke-deck", slides: [{ objectId: "slide-1" }] });
    }
    throw new Error(`Unexpected smoke request: ${url}`);
  };
  try {
    const driveConfig = {
      merged: { allowWrite: true },
      oauth: {
        connected: true,
        accessToken: "fixture",
        scopes: ["drive", "spreadsheets", "presentations"].map(scope => `https://www.googleapis.com/auth/${scope}`),
      },
    };
    const readFileTool = tool(drive, driveConfig, "read_file");
    const driveWorker = await checkPdf(drive, () => readFileTool({ fileId: "sample-pdf" }), originalWorker);
    const confluenceConfig = { merged: { subdomain: "fixture", email: "fixture@example.com", apiToken: "fixture" } };
    const readAttachment = tool(confluence, confluenceConfig, "download_and_extract_file");
    await checkPdf(confluence, () => readAttachment({ url: "https://fixture.atlassian.net/sample.pdf" }), driveWorker);
    const createSlides = tool(drive, driveConfig, "slides_create");
    const result = await createSlides({
      title: "Release smoke",
      slides: [{ elements: [{ kind: "text", x: 20, y: 20, w: 200, h: 50, text: "Release smoke" }] }],
    });
    assert.equal(result.presentationId, "smoke-deck");
    assert.deepEqual(result.slideIds, ["slide-1"]);
    assert((await stat(deck)).size > 0, "The PowerPoint file is empty.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWorker === undefined) delete globalThis.pdfjsWorker;
    else globalThis.pdfjsWorker = originalWorker;
  }
}

const scratch = await mkdtemp(join(await realpath(tmpdir()), "yoplai-release-smoke-"));
try {
  for (let path = scratch; ; path = dirname(path)) {
    assert(!existsSync(join(path, "node_modules")), `Smoke folder has access to dependencies at ${path}.`);
    if (dirname(path) === path) break;
  }
  const bundles = await loadArchives(scratch);
  await checkTools(bundles, scratch);
  console.log(`Imported ${bundles.size} archives. Read two PDFs with separate workers and wrote one PowerPoint deck.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
