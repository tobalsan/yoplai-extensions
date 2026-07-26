import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DealField,
  type FieldMeta,
  type FieldRegistry,
  FieldRegistrySchema,
} from "./models.js";

/** How long a cached registry is considered fresh (24h). */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long past the TTL a cached registry may still be served if a rebuild
 * fetch fails (7 days). Protects against transient Pipedrive outages.
 */
export const DEFAULT_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** Fetches every dealField page (v1 offset pagination) and returns the flat list. */
export type DealFieldsFetcher = () => Promise<DealField[]>;

export interface FieldRegistryStoreOptions {
  /** Absolute path to the cache file (defaults into the agent workspace dir). */
  cachePath?: string;
  ttlSeconds?: number;
  graceSeconds?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

let warnedLegacyWorkspaceEnv = false;
let warnedLegacyCachePath = false;

function trimValue(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

interface CacheLocation {
  /** Where the cache is read from first and always written. */
  cachePath: string;
  /** Pre-rename cache file, read only when `cachePath` is absent. */
  legacyCachePath: string | null;
}

/**
 * Default cache location: the agent workspace folder. Honors
 * YOPLAI_WORKSPACE_DIR, falling back to the legacy AIHUB_WORKSPACE_DIR (warns
 * once) when it is the one actually used (the runtime points it at the
 * per-agent workspace). Otherwise uses a stable local state dir,
 * ~/.local/state/yoplai/extensions/pipedrive, with the pre-rename
 * ~/.local/state/aihub/extensions/pipedrive kept only as a read fallback.
 * This replaces the legacy Redis cache with a local file.
 */
function defaultCacheLocation(): CacheLocation {
  const workspace = trimValue(process.env.YOPLAI_WORKSPACE_DIR);
  const legacyWorkspace = trimValue(process.env.AIHUB_WORKSPACE_DIR);
  const chosenWorkspace = workspace ?? legacyWorkspace;

  if (chosenWorkspace !== undefined) {
    if (workspace === undefined && !warnedLegacyWorkspaceEnv) {
      warnedLegacyWorkspaceEnv = true;
      console.warn("[pipedrive] AIHUB_WORKSPACE_DIR is deprecated; use YOPLAI_WORKSPACE_DIR instead.");
    }
    // The workspace dir itself was not renamed, so there is no legacy file there.
    return {
      cachePath: path.join(chosenWorkspace, ".cache", "deal_field_registry.json"),
      legacyCachePath: null,
    };
  }

  const stateDir = path.join(os.homedir(), ".local", "state", "yoplai", "extensions", "pipedrive");
  const legacyStateDir = path.join(os.homedir(), ".local", "state", "aihub", "extensions", "pipedrive");
  return {
    cachePath: path.join(stateDir, "deal_field_registry.json"),
    legacyCachePath: path.join(legacyStateDir, "deal_field_registry.json"),
  };
}

/** Absolute path the cache is read from first and always written to. */
export function defaultCachePath(): string {
  return defaultCacheLocation().cachePath;
}

/** Build the key→FieldMeta map and a deterministic version hash from raw fields. */
export function buildRegistry(fields: DealField[], now: () => number = Date.now): FieldRegistry {
  const byKey: Record<string, FieldMeta> = {};

  for (const field of fields) {
    let options: Record<string, string> | null = null;
    if (field.options && (field.field_type === "enum" || field.field_type === "set")) {
      options = {};
      for (const opt of field.options) {
        options[String(opt.id)] = opt.label;
      }
    }

    byKey[field.key] = {
      name: field.name,
      type: field.field_type,
      options,
      is_multiple: field.field_type === "set",
    };
  }

  const versionInput = JSON.stringify(Object.keys(byKey).sort());
  const version = createHash("sha256").update(versionInput).digest("hex").slice(0, 16);

  return {
    version,
    built_at: new Date(now()).toISOString(),
    entity: "deal",
    by_key: byKey,
  };
}

interface CacheEnvelope {
  fetchedAt: number;
  registry: FieldRegistry;
}

/**
 * File-backed dealField registry cache with a TTL and a stale-grace window.
 *
 * - `get()` returns the cached registry when fresh (within TTL) without
 *   re-fetching. On expiry it rebuilds from the API. If the rebuild fetch
 *   fails but a cached copy exists within the grace window, it serves the
 *   last-good copy instead of failing.
 * - `refresh(force=true)` always rebuilds from the API and overwrites the cache.
 */
export class FieldRegistryStore {
  readonly cachePath: string;
  private readonly legacyCachePath: string | null;
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetchFields: DealFieldsFetcher,
    options: FieldRegistryStoreOptions = {},
  ) {
    const location =
      options.cachePath === undefined
        ? defaultCacheLocation()
        : { cachePath: options.cachePath, legacyCachePath: null };
    this.cachePath = location.cachePath;
    this.legacyCachePath = location.legacyCachePath;
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.graceMs = (options.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Return a usable registry: cache hit within TTL, else rebuild (with stale-grace fallback). */
  async get(): Promise<FieldRegistry> {
    const cached = await this.readCache();

    if (cached && this.isFresh(cached)) {
      return cached.registry;
    }

    try {
      return await this.rebuild();
    } catch (error) {
      // Stale-grace: serve last-good on fetch failure if still within grace.
      if (cached && this.isWithinGrace(cached)) {
        return cached.registry;
      }
      throw error;
    }
  }

  /** Force a rebuild from the API and overwrite the cache. */
  async refresh(): Promise<FieldRegistry> {
    return this.rebuild();
  }

  private async rebuild(): Promise<FieldRegistry> {
    const fields = await this.fetchFields();
    const registry = buildRegistry(fields, this.now);
    await this.writeCache({ fetchedAt: this.now(), registry });
    return registry;
  }

  private isFresh(envelope: CacheEnvelope): boolean {
    return this.now() - envelope.fetchedAt < this.ttlMs;
  }

  private isWithinGrace(envelope: CacheEnvelope): boolean {
    return this.now() - envelope.fetchedAt < this.ttlMs + this.graceMs;
  }

  /**
   * Reads the cache, falling back to the pre-rename file only when the current
   * one is absent (a corrupt current file does not un-shadow it). Writes always
   * go to the current path, so the legacy file goes inert after the next write.
   */
  private async readCache(): Promise<CacheEnvelope | null> {
    const current = await this.readCacheAt(this.cachePath);
    if (current !== "absent") return current;
    if (this.legacyCachePath === null) return null;

    const legacy = await this.readCacheAt(this.legacyCachePath);
    if (legacy === "absent" || legacy === null) return null;

    if (!warnedLegacyCachePath) {
      warnedLegacyCachePath = true;
      console.warn(
        `[pipedrive] reading legacy cache ${this.legacyCachePath}; new caches are written to ${this.cachePath}.`,
      );
    }
    return legacy;
  }

  /** `"absent"` when there is no such file; `null` when it exists but is unusable. */
  private async readCacheAt(cachePath: string): Promise<CacheEnvelope | null | "absent"> {
    let raw: string;
    try {
      raw = await readFile(cachePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return "absent";
      // Unreadable cache: treat as unusable (a rebuild will replace it).
      return null;
    }

    try {
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw) as { fetchedAt?: unknown; registry?: unknown };
      if (typeof parsed.fetchedAt !== "number") return null;
      const registry = FieldRegistrySchema.parse(parsed.registry);
      return { fetchedAt: parsed.fetchedAt, registry };
    } catch {
      // Corrupt/unparseable cache: treat as unusable (a rebuild will replace it).
      return null;
    }
  }

  private async writeCache(envelope: CacheEnvelope): Promise<void> {
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const tmpPath = `${this.cachePath}.${process.pid}.${this.now()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
      await rename(tmpPath, this.cachePath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
