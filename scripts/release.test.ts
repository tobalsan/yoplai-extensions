import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = join(repo, "scripts/release.mjs");
const metadata = { version: "0.1.0", tagline: "Read a fixture", category: "data", minYoplai: "0.11.0" };
let root: string;

function git(...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function runRelease(...flags: string[]) {
  return spawnSync(process.execPath, [script, ...flags], { cwd: root, encoding: "utf8" });
}

async function addExtension(folder: string, id: string, overrides: Record<string, unknown> = {}, prelude = "") {
  const dir = join(root, "src", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "extension.json"), JSON.stringify({ ...metadata, ...overrides }));
  await writeFile(join(dir, "index.ts"), `${prelude}\nexport default ${JSON.stringify({ id, displayName: id, description: `Read ${id}` })};`);
}

async function makeRelease(...flags: string[]) {
  const result = runRelease(...flags);
  expect(result.status, result.stderr).toBe(0);
  const output = join(root, "release");
  const catalog = JSON.parse(await readFile(join(output, "catalog.json"), "utf8"));
  return { output, catalog };
}

beforeEach(async () => {
  root = await mkdtemp(join(repo, ".release-test-"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  git("init", "-q");
  git("add", "package.json");
  git("commit", "-qm", "Start the release fixture");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("release archives", () => {
  it("uses exported IDs and gives each archive and icon a tag URL", async () => {
    await addExtension("google-drive", "googleDrive");
    await addExtension("people-enrich", "people_enrich");
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await writeFile(join(root, "src/google-drive/icon.svg"), icon);
    const { output, catalog } = await makeRelease();
    expect(catalog.commit).toBe(git("rev-parse", "--short=7", "HEAD"));
    expect(catalog.extensions.map((entry: { id: string }) => entry.id)).toEqual(["googleDrive", "people_enrich"]);
    const entry = catalog.extensions[0];
    const base = `https://github.com/tobalsan/yoplai-extensions/releases/download/${catalog.release}`;
    expect(entry.url).toBe(`${base}/googleDrive-0.1.0.tgz`);
    expect(entry.iconUrl).toBe(`${base}/googleDrive.svg`);
    expect(entry.docsUrl).toBe("https://github.com/tobalsan/yoplai-extensions/tree/main/src/google-drive");
    expect(await readFile(join(output, "googleDrive.svg"), "utf8")).toBe(icon);
    const archive = join(output, "googleDrive-0.1.0.tgz");
    const bytes = await readFile(archive);
    expect(entry.size).toBe(bytes.length);
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(bytes[3] & 0x08).toBe(0);
    expect(bytes.readUInt32LE(4)).toBe(0);
    const files: string[] = [];
    await list({ file: archive, onReadEntry(file) {
      files.push(file.path);
      expect(file.type).toBe("File");
      expect(file.mode).toBe(0o644);
      expect(file.uid).toBe(0);
      expect(file.gid).toBe(0);
      expect(file.mtime?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    } });
    expect(files).toEqual(["icon.svg", "index.js", "manifest.json"]);
  });

  it("keeps hashes stable across runs and changes only the edited archive", async () => {
    await addExtension("a", "a");
    await addExtension("b", "b");
    git("add", "src");
    git("commit", "-qm", "Add two fixture extensions");
    const first = (await makeRelease()).catalog;
    const second = (await makeRelease()).catalog;
    const hashes = (catalog: typeof first): string[] => catalog.extensions.map((entry: { sha256: string }) => entry.sha256);
    expect(hashes(second)).toEqual(hashes(first));
    await addExtension("a", "a", { tagline: "Read a new fixture" });
    git("add", "src/a");
    git("commit", "-qm", "Change extension A");
    const third = (await makeRelease()).catalog;
    expect(third.commit).not.toBe(first.commit);
    expect(hashes(third)[0]).not.toBe(hashes(first)[0]);
    expect(hashes(third)[1]).toBe(hashes(first)[1]);
  });

  it("packs a hidden extension and has no icon URL for an extension without an icon", async () => {
    await addExtension("hidden", "hidden", { catalog: false });
    await addExtension("plain", "plain");
    await addExtension("with-icon", "withIcon", { docsUrl: "https://example.invalid/docs" });
    await writeFile(join(root, "src/with-icon/icon.png"), Buffer.from([1, 2, 3]));
    const { output, catalog } = await makeRelease("--base-url", "http://127.0.0.1:1337/assets/");
    const [plain, withIcon] = catalog.extensions;
    expect(catalog.extensions).toHaveLength(2);
    expect(plain.url).toBe("http://127.0.0.1:1337/assets/plain-0.1.0.tgz");
    expect(plain).not.toHaveProperty("iconUrl");
    expect(withIcon.iconUrl).toBe("http://127.0.0.1:1337/assets/withIcon.png");
    expect(withIcon.docsUrl).toBe("https://example.invalid/docs");
    expect((await readFile(join(output, "hidden-0.1.0.tgz"))).length).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(join(output, "plain/manifest.json"), "utf8"));
    expect(manifest.icon).toBeNull();
  });

  it.each(["Sample", "sample"])("rejects a second ID of %s", async duplicate => {
    await addExtension("a", "Sample");
    await addExtension("b", duplicate);
    const result = runRelease();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Duplicate extension ID: ${duplicate}`);
  });

  it("rejects an invalid ID", async () => {
    await addExtension("sample", "../sample");
    const result = runRelease();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid extension ID in sample");
  });

  it("rejects an unknown category", async () => {
    await addExtension("sample", "sample", { category: "unknown" });
    const result = runRelease();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown category in sample: unknown");
  });

  it.each([
    ["", "const SCALE_MATRIX = new DOMMatrix();"],
    ["const SCALE_MATRIX = new DOMMatrix();", "try {"],
  ])("rejects a PDF.js parser without the expected patch text (%j)", async (source, missing) => {
    await addExtension("sample", "sample", {}, 'import "../../pdfjs-dist/legacy/build/pdf.mjs";');
    const parser = join(root, "pdfjs-dist/legacy/build");
    await mkdir(parser, { recursive: true });
    await writeFile(join(parser, "pdf.mjs"), source);
    const result = runRelease();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Cannot patch PDF.js: ${missing}`);
  });
});
