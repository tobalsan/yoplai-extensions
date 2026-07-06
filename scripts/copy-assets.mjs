// Copy per-extension static assets that `tsc` does not emit (it only compiles
// .ts). Extension icons live at src/<name>/icon.svg|png and must sit next to
// the compiled index.js in dist/<name>/ so the gateway can auto-detect them.
import { readdir, mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const ICONS = ["icon.svg", "icon.png"];

const entries = await readdir(srcDir, { withFileTypes: true });
let copied = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  for (const icon of ICONS) {
    const from = path.join(srcDir, entry.name, icon);
    try {
      await access(from);
    } catch {
      continue; // no such icon for this extension
    }
    const destDir = path.join(distDir, entry.name);
    await mkdir(destDir, { recursive: true });
    await copyFile(from, path.join(destDir, icon));
    copied += 1;
    console.log(`copied ${entry.name}/${icon}`);
  }
}

console.log(`copy-assets: ${copied} icon(s) copied to dist/`);
