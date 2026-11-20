import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { create } from "tar";

const REPO = "https://github.com/tobalsan/yoplai-extensions";
const CATEGORIES = new Set(["communication", "productivity", "sales", "support", "data", "search", "finance", "developer"]);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MTIME = new Date("2000-01-01T00:00:00Z");
const SCALE_MATRIX = "const SCALE_MATRIX = new DOMMatrix();";
const GLOBAL_WORKER = `    try {
      return globalThis.pdfjsWorker?.WorkerMessageHandler || null;
    } catch {
      return null;
    }`;

function patchPdfjs(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Cannot patch PDF.js: ${before.trim().split("\n")[0]}`);
  return source.replace(before, after);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function bundle(root, source, staging) {
  let worker;
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(source, "index.ts")],
    outfile: "index.js",
    write: false,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [{
      name: "bundle-pdfjs",
      setup(plugin) {
        plugin.onLoad({ filter: /[/\\]pdfjs-dist[/\\]legacy[/\\]build[/\\]pdf\.mjs$/ }, async ({ path }) => {
          const original = await readFile(path, "utf8");
          const matrix = patchPdfjs(original, SCALE_MATRIX, "const SCALE_MATRIX = globalThis.DOMMatrix ? new DOMMatrix() : undefined;");
          // Load the worker beside this bundle, even if another worker sets the process global.
          const parser = patchPdfjs(matrix, GLOBAL_WORKER, "    return null;");
          worker = join(dirname(path), "pdf.worker.mjs");
          return { contents: `${parser}
const siblingWorker = new URL("./pdf.worker.mjs", import.meta.url);
const workerVersion = new URL(import.meta.url).searchParams.get("v");
if (workerVersion !== null) siblingWorker.searchParams.set("v", workerVersion);
GlobalWorkerOptions.workerSrc = siblingWorker.href;
`, resolveDir: dirname(path) };
        });
      },
    }],
  });
  const entry = join(staging, "index.js");
  await writeFile(entry, result.outputFiles[0].contents);
  if (worker) await copyFile(worker, join(staging, "pdf.worker.mjs"));
  return (await import(pathToFileURL(entry))).default;
}

async function pack(output, folder, files, asset) {
  const path = join(output, asset);
  await create({
    cwd: folder,
    file: path,
    gzip: { portable: true },
    mtime: MTIME,
    strict: true,
    onWriteEntry(entry) {
      if (entry.type !== "File") throw new Error(`Invalid archive entry: ${entry.path}`);
      entry.myuser = "";
      Object.assign(entry.stat, { uid: 0, gid: 0, mode: 0o644, atime: undefined, ctime: undefined });
    },
  }, files.sort());
  const bytes = await readFile(path);
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const { values } = parseArgs({ options: { "base-url": { type: "string" } } });
const root = process.cwd();
const now = new Date();
const commit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const release = `v${now.toISOString().slice(0, 10).replaceAll("-", ".")}-${commit}`;
const base = (values["base-url"] ?? `${REPO}/releases/download/${release}`).replace(/\/+$/, "");
const output = join(root, "release");
const sources = join(root, "src");
const extensions = [];
const ids = new Set();

await rm(output, { recursive: true, force: true });
await mkdir(output);
const folders = (await readdir(sources, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
for (const folder of folders.sort()) {
  const source = join(sources, folder);
  if (!(await exists(join(source, "index.ts")))) continue;
  const meta = JSON.parse(await readFile(join(source, "extension.json"), "utf8"));
  if (!CATEGORIES.has(meta.category)) throw new Error(`Unknown category in ${folder}: ${meta.category}`);
  if (typeof meta.version !== "string" || !VERSION.test(meta.version)) throw new Error(`Invalid version in ${folder}.`);
  const staging = await mkdtemp(join(output, ".bundle-"));
  const extension = await bundle(root, source, staging);
  const { id, displayName: name, description } = extension ?? {};
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`Invalid extension ID in ${folder}: ${id}`);
  }
  const key = id.toLowerCase();
  if (ids.has(key)) throw new Error(`Duplicate extension ID: ${id}`);
  ids.add(key);

  const extensionDir = join(output, id);
  await rename(staging, extensionDir);
  let icon = null;
  let iconAsset;
  for (const format of ["svg", "png"]) {
    const candidate = join(source, `icon.${format}`);
    if (!(await exists(candidate))) continue;
    icon = `icon.${format}`;
    iconAsset = `${id}.${format}`;
    await copyFile(candidate, join(extensionDir, icon));
    await copyFile(candidate, join(output, iconAsset));
    break;
  }
  const { version, tagline, category, minYoplai, docsUrl = `${REPO}/tree/main/src/${folder}` } = meta;
  const details = { id, name, description, tagline, category, version, minYoplai, docsUrl };
  const manifest = { ...details, entry: "index.js", icon };
  await writeFile(join(extensionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const asset = `${id}-${version}.tgz`;
  const integrity = await pack(output, extensionDir, await readdir(extensionDir), asset);
  if (meta.catalog !== false) {
    extensions.push({ ...details, url: `${base}/${asset}`, ...integrity, ...(iconAsset ? { iconUrl: `${base}/${iconAsset}` } : {}) });
  }
}

extensions.sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id));
const catalog = { schemaVersion: 1, generatedAt: now.toISOString(), commit, release, extensions };
await writeFile(join(output, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Built ${ids.size} archives and ${extensions.length} catalog entries.`);
