import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import { PipedriveWriteClient } from "../write-client.js";

export const KEY_NOTES = "a".repeat(40);
export const KEY_CATEGORY = "b".repeat(40);
export const KEY_BUDGET = "c".repeat(40);
export const KEY_TAGS = "d".repeat(40);
export const KEY_VAT = "e".repeat(40);
export const KEY_PERIOD = "f".repeat(40);
export const LEAD_ID = "adf21080-0e10-11eb-879b-05d71fb426ec";
export const AUDIT_LEAD_ID = "11111111-2222-4333-8444-555555555555";
export const LABEL_ID = "6c00d2d8-4276-4437-9024-6dc23c6f2fda";

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

type Responder = unknown | ((call: Call) => unknown);

/**
 * Routes `"METHOD /api/vN/path"` to a response. A function receives the call, an
 * array is consumed in order (last repeats), anything else is returned as JSON 200.
 * A Response instance is returned as is. Unrouted requests fail the test loudly.
 */
export function mockApi(routes: Record<string, Responder | Responder[]>): { calls: Call[]; to: (key: string) => Call[] } {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`Unrouted request: ${key}`);
    let responder: Responder = route;
    if (Array.isArray(route)) {
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      responder = route[Math.min(index, route.length - 1)];
    }
    const value = typeof responder === "function" ? (responder as (c: Call) => unknown)(call) : responder;
    return value instanceof Response ? value : jsonResponse(value);
  });
  return { calls, to: (key) => calls.filter((call) => `${call.method} ${call.path}` === key) };
}

export const EMPTY_SEARCH = { data: { items: [] }, additional_data: {} };
export const EMPTY_LIST = { data: [], additional_data: {} };
export const NO_MORE = { pagination: { start: 0, limit: 500, more_items_in_collection: false } };

/** v2 `GET /leads/search` page shaped like the Pipedrive reference: `data.items[].item` plus `additional_data.next_cursor`. */
export function leadSearchPage(hits: { id: string; title: string }[], nextCursor: string | null = null) {
  return {
    success: true,
    data: {
      items: hits.map((hit) => ({
        result_score: 0.9,
        item: { id: hit.id, type: "lead", title: hit.title, owner: { id: 5 }, person: { id: 11 }, organization: null, is_archived: false },
      })),
    },
    additional_data: { next_cursor: nextCursor },
  };
}

export const USERS = {
  data: [
    { id: 5, name: "Alice", email: "alice@acme.test", active_flag: true },
    { id: 6, name: "Bob", email: "bob@acme.test", active_flag: true },
    { id: 7, name: "Gone", email: "gone@acme.test", active_flag: false },
  ],
};

export const DEAL_FIELDS = {
  data: [
    { id: 1, key: "title", name: "Title", field_type: "varchar" },
    { id: 2, key: KEY_NOTES, name: "Qualification notes", field_type: "text", edit_flag: true },
    {
      id: 3,
      key: KEY_CATEGORY,
      name: "Forecast category",
      field_type: "enum",
      edit_flag: true,
      options: [
        { id: 11, label: "Pipeline" },
        { id: 12, label: "Commit" },
      ],
    },
    { id: 4, key: KEY_BUDGET, name: "Budget", field_type: "monetary", edit_flag: true },
    {
      id: 5,
      key: KEY_TAGS,
      name: "Segments",
      field_type: "set",
      edit_flag: true,
      options: [
        { id: 21, label: "SMB" },
        { id: 22, label: "Enterprise" },
      ],
    },
    { id: 6, key: KEY_PERIOD, name: "Contract period", field_type: "daterange", edit_flag: true },
  ],
  additional_data: NO_MORE,
};

export const ORGANIZATION_FIELDS = {
  data: [
    { id: 1, key: "name", name: "Name", field_type: "varchar" },
    { id: 9, key: KEY_VAT, name: "VAT number", field_type: "varchar", edit_flag: true },
  ],
  additional_data: NO_MORE,
};

export const NOTE_CREATED = { success: true, data: { id: 900 } };

/** Client with writes enabled (or not) and an isolated registry cache. */
export function useWriteClient(): { client: (allowWrite?: boolean) => PipedriveWriteClient } {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pipedrive-write-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    client: (allowWrite = true) =>
      new PipedriveWriteClient({
        apiToken: "secret-token",
        domain: "acme",
        allowWrite,
        timeoutMs: 1_000,
        conversionPollDelayMs: 0,
        registryOptions: { cachePath: path.join(dir, "registry.json") },
      }),
  };
}
