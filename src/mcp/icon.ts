import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { isNonPublicAddress } from "./gateway-reachability.js";
import { raceTimeout } from "./timeout.js";

export interface ServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);
const MAX_DATA_URI_BYTES = 64 * 1024;

/** Normalize server metadata both before saving and after reading it. Render only through <img>, never inline or as a document. */
export function normalizeServerIcon(input: unknown, serverUrl?: string): string | undefined {
  const icons: ServerIcon[] = typeof input === "string" ? [{ src: input }] : Array.isArray(input)
    ? input.filter((icon): icon is ServerIcon => !!icon && typeof icon === "object" && typeof icon.src === "string") : [];
  const ranked = [...icons].sort((a, b) => Number(a.theme === "dark") - Number(b.theme === "dark")
    || Number(IMAGE_TYPES.has(b.mimeType ?? "")) - Number(IMAGE_TYPES.has(a.mimeType ?? "")));
  for (const icon of ranked) {
    try {
      if (icon.src.startsWith("data:")) {
        const data = icon.src.match(/^data:([^;,]+)(;base64)?,([\s\S]+)$/i);
        if (!data || Buffer.byteLength(icon.src, "utf8") > MAX_DATA_URI_BYTES || !IMAGE_TYPES.has(data[1].toLowerCase())) continue;
        const svg = data[1].toLowerCase() === "image/svg+xml";
        if (!data[2] && !svg) continue;
        if (data[2] && (!/^[A-Za-z0-9+/]+={0,2}$/.test(data[3]) || data[3].length % 4 === 1)) continue;
        if (svg) {
          const text = (data[2] ? Buffer.from(data[3], "base64").toString("utf8") : decodeURIComponent(data[3]))
            .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code: string) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)))
            .replace(/&(?:Tab|NewLine);/gi, " ")
            .replace(/&colon;/gi, ":");
          if (/<(?:[\w.-]+:)?(?:script|foreignobject)\b|[\s/]on[\w:.-]+\s*=|<!DOCTYPE|<!ENTITY/i.test(text)
            || /javascript:/i.test(text.replace(/[\s\u0000-\u001f]/g, ""))) continue;
        }
        return icon.src;
      }
      const url = new URL(icon.src, serverUrl);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.href.length <= 2048) return url.href;
    } catch { /* ignore invalid icons */ }
  }
  return undefined;
}

/** Site label for a host, used as a readable server key: `mcp.linear.app` → `linear`, `claap.io` → `claap`. */
export function siteLabel(hostname: string): string {
  const site = rootDomain(hostname) ?? hostname;
  const label = /^[\d.]+$/.test(site) || site.includes(":") ? site : site.split(".")[0];
  return label.toLowerCase().replace(/[^a-z0-9_]/g, "_") || "server";
}

const TIMEOUT_MS = 5_000;

export function dataIcon(icon: string | undefined): string | undefined {
  return icon?.startsWith("data:") ? icon : undefined;
}

function canDownloadIcon(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, "");
  const address = host.replace(/^\[|\]$/g, "");
  return (url.protocol === "http:" || url.protocol === "https:")
    && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
    && !(isIP(address) && isNonPublicAddress(address));
}

async function downloadIcon(src: string, signal: AbortSignal): Promise<string | undefined> {
  let url = new URL(src);
  for (let redirects = 0; redirects <= 3 && canDownloadIcon(url); redirects++) {
    signal.throwIfAborted();
    const response = await fetch(url.href, { redirect: "manual", signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return undefined;
      url = new URL(location, url);
      continue;
    }

    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!type || !IMAGE_TYPES.has(type)) {
      void response.body?.cancel().catch(() => {});
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    const maxBytes = Math.floor((MAX_DATA_URI_BYTES - `data:${type};base64,`.length) / 4) * 3;
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) return undefined;
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return normalizeServerIcon(`data:${type};base64,${Buffer.concat(chunks).toString("base64")}`);
  }
  return undefined;
}

export async function inlineIcon(src: string | undefined): Promise<string | undefined> {
  if (!src || dataIcon(src)) return src;
  return raceTimeout(downloadIcon(src, AbortSignal.timeout(TIMEOUT_MS)).catch(() => undefined), TIMEOUT_MS);
}

function rootDomain(hostname: string): string | undefined {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return undefined;
  const labels = hostname.split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : undefined;
}

async function fetchOk(url: string): Promise<Response | undefined> {
  try {
    const response = await raceTimeout(fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) }), TIMEOUT_MS);
    return response?.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

function iconFromHtml(html: string, base: string): string | undefined {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  const ranked = links
    .map((tag) => ({ rel: attr(tag, "rel")?.toLowerCase() ?? "", href: attr(tag, "href") }))
    .filter((link) => link.href && /(^|\s)(icon|apple-touch-icon)(\s|$)/.test(link.rel))
    .sort((a, b) => Number(b.rel.includes("apple-touch-icon")) - Number(a.rel.includes("apple-touch-icon")));
  for (const link of ranked) {
    try {
      const url = new URL(link.href!, base);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch { /* ignore invalid hrefs */ }
  }
  return undefined;
}

async function findIcon(origin: string): Promise<string | undefined> {
  // Probe page and favicon in parallel so lookup stays bounded by one timeout.
  const [page, favicon] = await Promise.all([fetchOk(`${origin}/`), fetchOk(`${origin}/favicon.ico`)]);
  if (page && page.headers?.get("content-type")?.includes("text/html")) {
    const html = await page.text().catch(() => "");
    const icon = iconFromHtml(html, page.url || `${origin}/`);
    if (icon) return icon;
  }
  return favicon?.headers?.get("content-type")?.startsWith("image/") ? favicon.url || `${origin}/favicon.ico` : undefined;
}

/** Hosted MCP servers whose serverInfo/site give no usable label or icon (e.g. Google reports "StatelessServer"). */
const KNOWN_SERVERS: Record<string, { title: string; iconUrl: string }> = {
  "calendarmcp.googleapis.com": { title: "Google Calendar", iconUrl: "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png" },
};

export function knownServer(url: string): { title: string; iconUrl: string } | undefined {
  try { return KNOWN_SERVERS[new URL(url).host.toLowerCase()]; } catch { return undefined; }
}

/** Resolves website icons for HTTP MCP servers and caches their data URIs by hostname. */
export function createIconResolver(dataDir: string) {
  const file = path.join(dataDir, "mcp", "icons.json");
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* no cache yet */ }
  const pending = new Map<string, Promise<string | undefined>>();

  async function lookup(serverUrl: string): Promise<string | undefined> {
    const { protocol, hostname } = new URL(serverUrl);
    const root = rootDomain(hostname);
    const known = knownServer(serverUrl)?.iconUrl;
    const [hostIcon, rootIcon] = known ? [known] : await Promise.all([findIcon(`${protocol}//${hostname}`), root ? findIcon(`${protocol}//${root}`) : undefined]);
    return inlineIcon(hostIcon ?? rootIcon);
  }

  function startLookup(serverUrl: string, hostname: string): Promise<string | undefined> {
    const result = lookup(serverUrl).then((icon) => {
      if (pending.get(hostname) !== result) return dataIcon(cache[hostname]);
      if (icon) {
        cache[hostname] = icon;
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
        } catch { /* cache is best-effort */ }
      }
      return icon;
    }).catch(() => undefined);
    pending.set(hostname, result);
    return result;
  }

  const cached = (serverUrl: string): string | undefined => {
    try { return dataIcon(cache[new URL(serverUrl).hostname]); } catch { return undefined; }
  };
  const refresh = (serverUrl: string): Promise<string | undefined> => {
    let hostname: string;
    try { hostname = new URL(serverUrl).hostname; } catch { return Promise.resolve(undefined); }
    return startLookup(serverUrl, hostname);
  };
  return Object.assign((serverUrl: string): Promise<string | undefined> => {
    let hostname: string;
    try { hostname = new URL(serverUrl).hostname; } catch { return Promise.resolve(undefined); }
    const saved = cached(serverUrl);
    if (saved) return Promise.resolve(saved);
    // Misses stay memoized for the process lifetime to avoid re-probing on every refresh.
    return pending.get(hostname) ?? startLookup(serverUrl, hostname);
  }, { cached, refresh });
}
