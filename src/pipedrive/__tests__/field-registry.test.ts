import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
