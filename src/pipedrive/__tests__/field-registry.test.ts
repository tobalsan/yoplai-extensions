import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_TTL_SECONDS,
  FieldRegistryStore,
  buildRegistry,
} from "../field-registry.js";
import { type DealField } from "../models.js";

function field(overrides: Partial<DealField> = {}): DealField {
  return {
    id: 1,
    key: "hash1",
    name: "Field1",
    field_type: "varchar",
    options: null,
    ...overrides,
  };
}

describe("buildRegistry", () => {
  it("maps enum/set options into a string id→label record and flags is_multiple for sets", () => {
    const registry = buildRegistry([
      field({ key: "e", name: "Priority", field_type: "enum", options: [{ id: 26, label: "High" }] }),
      field({ key: "s", name: "Tags", field_type: "set", options: [{ id: 10, label: "Ent" }] }),
      field({ key: "v", name: "Notes", field_type: "varchar", options: null }),
    ]);

    expect(registry.by_key.e.options).toEqual({ "26": "High" });
    expect(registry.by_key.e.is_multiple).toBe(false);
    expect(registry.by_key.s.options).toEqual({ "10": "Ent" });
    expect(registry.by_key.s.is_multiple).toBe(true);
    expect(registry.by_key.v.options).toBeNull();
  });

  it("computes a deterministic 16-char version from sorted keys", () => {
    const a = buildRegistry([field({ key: "zzz", name: "Z" }), field({ key: "aaa", name: "A" })]);
    const b = buildRegistry([field({ key: "aaa", name: "A" }), field({ key: "zzz", name: "Z" })]);
    expect(a.version).toHaveLength(16);
    expect(a.version).toBe(b.version); // order-independent
  });
});

describe("FieldRegistryStore", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pd-registry-"));
    cachePath = path.join(dir, "registry.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("fetches fresh on a cold cache and writes the cache file", async () => {
    let clock = 1_000_000;
    const fetcher = vi.fn(async () => [field({ key: "hash1", name: "Priority" })]);
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    const registry = await store.get();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registry.by_key.hash1.name).toBe("Priority");
    const written = JSON.parse(await readFile(cachePath, "utf8"));
    expect(written.registry.by_key.hash1.name).toBe("Priority");
    expect(written.fetchedAt).toBe(clock);
  });

  it("coalesces concurrent cold-cache reads into one rebuild", async () => {
    const clock = 1_000_000;
    let releaseFetch: ((fields: DealField[]) => void) | undefined;
    const fetchResult = new Promise<DealField[]>((resolve) => {
      releaseFetch = resolve;
    });
    const fetcher = vi.fn(() => fetchResult);
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    const first = store.get();
    const second = store.get();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFetch?.([field({ key: "hash1", name: "Priority" })]);

    const [firstRegistry, secondRegistry] = await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstRegistry).toBe(secondRegistry);
    const written = JSON.parse(await readFile(cachePath, "utf8"));
    expect(written.registry.by_key.hash1.name).toBe("Priority");
  });

  it("serves the cache within TTL without re-fetching", async () => {
    let clock = 1_000_000;
    const fetcher = vi.fn(async () => [field({ key: "hash1", name: "Priority" })]);
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    await store.get(); // cold fetch
    clock += (DEFAULT_TTL_SECONDS - 10) * 1000; // still fresh
    const again = await store.get();

    expect(fetcher).toHaveBeenCalledTimes(1); // no second fetch
    expect(again.by_key.hash1.name).toBe("Priority");
  });

  it("rebuilds once the TTL expires", async () => {
    let clock = 1_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([field({ key: "hash1", name: "Old" })])
      .mockResolvedValueOnce([field({ key: "hash1", name: "New" })]);
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    await store.get();
    clock += (DEFAULT_TTL_SECONDS + 10) * 1000; // expired
    const rebuilt = await store.get();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rebuilt.by_key.hash1.name).toBe("New");
  });

  it("serves last-good within the grace window when a rebuild fetch fails", async () => {
    let clock = 1_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([field({ key: "hash1", name: "Cached" })])
      .mockRejectedValueOnce(new Error("Pipedrive down"));
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    await store.get(); // populate
    clock += (DEFAULT_TTL_SECONDS + 60) * 1000; // expired but within grace
    const served = await store.get();

    expect(fetcher).toHaveBeenCalledTimes(2); // attempted rebuild
    expect(served.by_key.hash1.name).toBe("Cached"); // fell back to last-good
  });

  it("propagates the error past the grace window with no usable cache", async () => {
    let clock = 1_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([field({ key: "hash1", name: "Cached" })])
      .mockRejectedValueOnce(new Error("Pipedrive down"));
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    await store.get();
    clock += (DEFAULT_TTL_SECONDS + DEFAULT_GRACE_SECONDS + 60) * 1000; // past grace
    await expect(store.get()).rejects.toThrow("Pipedrive down");
  });

  it("refresh() forces a rebuild even within TTL", async () => {
    let clock = 1_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([field({ key: "hash1", name: "Old" })])
      .mockResolvedValueOnce([field({ key: "hash999", name: "New" })]);
    const store = new FieldRegistryStore(fetcher, { cachePath, now: () => clock });

    await store.get();
    const refreshed = await store.refresh(); // within TTL, still rebuilds

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.by_key.hash999.name).toBe("New");
  });

  it("treats a corrupt cache file as a cold cache", async () => {
    await writeFile(cachePath, "{ not json", "utf8");
    const fetcher = vi.fn(async () => [field({ key: "hash1", name: "Priority" })]);
    const store = new FieldRegistryStore(fetcher, { cachePath });

    const registry = await store.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registry.by_key.hash1.name).toBe("Priority");
  });
});

describe("defaultCachePath", () => {
  const originalHome = process.env.HOME;
  const originalNewWorkspace = process.env.YOPLAI_WORKSPACE_DIR;
  const originalLegacyWorkspace = process.env.AIHUB_WORKSPACE_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalNewWorkspace === undefined) delete process.env.YOPLAI_WORKSPACE_DIR;
    else process.env.YOPLAI_WORKSPACE_DIR = originalNewWorkspace;
    if (originalLegacyWorkspace === undefined) delete process.env.AIHUB_WORKSPACE_DIR;
    else process.env.AIHUB_WORKSPACE_DIR = originalLegacyWorkspace;

    vi.restoreAllMocks();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers YOPLAI_WORKSPACE_DIR over the legacy AIHUB_WORKSPACE_DIR and does not warn", async () => {
    process.env.YOPLAI_WORKSPACE_DIR = "/tmp/yoplai-ws";
    process.env.AIHUB_WORKSPACE_DIR = "/tmp/aihub-ws";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(path.join("/tmp/yoplai-ws", ".cache", "deal_field_registry.json"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the legacy AIHUB_WORKSPACE_DIR and warns once", async () => {
    delete process.env.YOPLAI_WORKSPACE_DIR;
    process.env.AIHUB_WORKSPACE_DIR = "/tmp/aihub-ws";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(path.join("/tmp/aihub-ws", ".cache", "deal_field_registry.json"));
    defaultCachePath();

    const legacyWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === "string" && message.includes("AIHUB_WORKSPACE_DIR"),
    );
    expect(legacyWarnings).toHaveLength(1);
  });

  it("prefers the new state dir over the legacy one when both exist", async () => {
    const home = await tempHome();
    delete process.env.YOPLAI_WORKSPACE_DIR;
    delete process.env.AIHUB_WORKSPACE_DIR;
    process.env.HOME = home;
    await mkdir(path.join(home, ".local", "state", "yoplai", "extensions", "pipedrive"), { recursive: true });
    await mkdir(path.join(home, ".local", "state", "aihub", "extensions", "pipedrive"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(
      path.join(home, ".local", "state", "yoplai", "extensions", "pipedrive", "deal_field_registry.json"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves to the new state dir even when only the legacy state dir exists", async () => {
    const home = await tempHome();
    delete process.env.YOPLAI_WORKSPACE_DIR;
    delete process.env.AIHUB_WORKSPACE_DIR;
    process.env.HOME = home;
    await mkdir(path.join(home, ".local", "state", "aihub", "extensions", "pipedrive"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(newStateCachePath(home));
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a legacy state-dir cache, then writes the refreshed cache to the new state dir", async () => {
    const home = await tempHome();
    const legacyCachePath = await seedLegacyCache(home, 1_000_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { FieldRegistryStore } = await import("../field-registry.js");

    const fetcher = vi.fn(async () => [field({ key: "hash2", name: "Fresh" })]);
    const store = new FieldRegistryStore(fetcher, { now: () => 1_000_000 });
    expect(store.cachePath).toBe(newStateCachePath(home));

    // The legacy cache is still honored...
    const served = await store.get();
    expect(fetcher).not.toHaveBeenCalled();
    expect(served.by_key.hash1.name).toBe("Legacy");

    // ...but the rebuild lands on the new path, leaving the legacy file inert.
    const refreshed = await store.refresh();
    expect(refreshed.by_key.hash2.name).toBe("Fresh");
    const written = JSON.parse(await readFile(newStateCachePath(home), "utf8"));
    expect(written.registry.by_key.hash2.name).toBe("Fresh");
    const legacyAfter = JSON.parse(await readFile(legacyCachePath, "utf8"));
    expect(legacyAfter.registry.by_key.hash1.name).toBe("Legacy");

    // A later process reads the new file and never shadows it with the legacy one.
    const nextFetcher = vi.fn(async () => [field({ key: "hash3", name: "Unused" })]);
    const next = await new FieldRegistryStore(nextFetcher, { now: () => 1_000_000 }).get();
    expect(nextFetcher).not.toHaveBeenCalled();
    expect(next.by_key.hash2.name).toBe("Fresh");

    const legacyWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === "string" && message.includes(legacyCachePath),
    );
    expect(legacyWarnings).toHaveLength(1);
    expect(String(legacyWarnings[0][0])).toContain(newStateCachePath(home));
  });

  it("serves a legacy state-dir cache within the stale-grace window when the fetch fails", async () => {
    const home = await tempHome();
    await seedLegacyCache(home, 1_000_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { FieldRegistryStore } = await import("../field-registry.js");

    const fetcher = vi.fn().mockRejectedValue(new Error("Pipedrive down"));
    const clock = 1_000_000 + (DEFAULT_TTL_SECONDS + 60) * 1000; // expired, within grace
    const served = await new FieldRegistryStore(fetcher, { now: () => clock }).get();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(served.by_key.hash1.name).toBe("Legacy");
  });

  it("ignores an empty YOPLAI_WORKSPACE_DIR and uses the legacy workspace, warning once", async () => {
    process.env.YOPLAI_WORKSPACE_DIR = "";
    process.env.AIHUB_WORKSPACE_DIR = "/tmp/legacy-ws";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(path.join("/tmp/legacy-ws", ".cache", "deal_field_registry.json"));

    const legacyWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === "string" && message.includes("AIHUB_WORKSPACE_DIR"),
    );
    expect(legacyWarnings).toHaveLength(1);
  });

  it("ignores an empty legacy AIHUB_WORKSPACE_DIR without warning", async () => {
    const home = await tempHome();
    delete process.env.YOPLAI_WORKSPACE_DIR;
    process.env.AIHUB_WORKSPACE_DIR = "  ";
    process.env.HOME = home;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(newStateCachePath(home));
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the new state dir when neither exists", async () => {
    const home = await tempHome();
    delete process.env.YOPLAI_WORKSPACE_DIR;
    delete process.env.AIHUB_WORKSPACE_DIR;
    process.env.HOME = home;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { defaultCachePath } = await import("../field-registry.js");

    expect(defaultCachePath()).toBe(
      path.join(home, ".local", "state", "yoplai", "extensions", "pipedrive", "deal_field_registry.json"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pd-registry-home-"));
    tempDirs.push(dir);
    return dir;
  }

  function newStateCachePath(home: string): string {
    return path.join(home, ".local", "state", "yoplai", "extensions", "pipedrive", "deal_field_registry.json");
  }

  /** Simulate a pre-rename install: only the legacy state dir holds a cache. */
  async function seedLegacyCache(home: string, fetchedAt: number): Promise<string> {
    delete process.env.YOPLAI_WORKSPACE_DIR;
    delete process.env.AIHUB_WORKSPACE_DIR;
    process.env.HOME = home;
    const legacyDir = path.join(home, ".local", "state", "aihub", "extensions", "pipedrive");
    await mkdir(legacyDir, { recursive: true });
    const legacyCachePath = path.join(legacyDir, "deal_field_registry.json");
    const registry = buildRegistry([field({ key: "hash1", name: "Legacy" })], () => fetchedAt);
    await writeFile(legacyCachePath, JSON.stringify({ fetchedAt, registry }), "utf8");
    return legacyCachePath;
  }
});
