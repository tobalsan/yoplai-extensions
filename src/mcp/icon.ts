import fs from "node:fs";
import path from "node:path";
import { raceTimeout } from "./timeout.js";

export interface ServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/** Normalize server metadata both before saving and after reading it. Render only through <img>, never inline or as a document. */
export function normalizeServerIcon(input: unknown, serverUrl: string): string | undefined {
  const icons: ServerIcon[] = typeof input === "string" ? [{ src: input }] : Array.isArray(input)
    ? input.filter((icon): icon is ServerIcon => !!icon && typeof icon === "object" && typeof icon.src === "string") : [];
  const ranked = [...icons].sort((a, b) => Number(a.theme === "dark") - Number(b.theme === "dark")
    || Number(IMAGE_TYPES.has(b.mimeType ?? "")) - Number(IMAGE_TYPES.has(a.mimeType ?? "")));
  for (const icon of ranked) {
    try {
      if (icon.src.startsWith("data:")) {
        const data = icon.src.match(/^data:([^;,]+)(;base64)?,([\s\S]+)$/i);
        if (!data || Buffer.byteLength(icon.src, "utf8") > 32 * 1024 || !IMAGE_TYPES.has(data[1].toLowerCase())) continue;
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

/** Resolves website icons for HTTP MCP servers, persisted as a hostname → icon URL map. */
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
    const icon = hostIcon ?? rootIcon;
    if (icon) {
      cache[hostname] = icon;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
      } catch { /* cache is best-effort */ }
    }
    return icon;
  }

  const cached = (serverUrl: string): string | undefined => {
    try { return cache[new URL(serverUrl).hostname]; } catch { return undefined; }
  };
  const refresh = (serverUrl: string): Promise<string | undefined> => {
    let hostname: string;
    try { hostname = new URL(serverUrl).hostname; } catch { return Promise.resolve(undefined); }
    pending.delete(hostname);
    const result = lookup(serverUrl).catch(() => undefined);
    pending.set(hostname, result);
    return result;
  };
  return Object.assign((serverUrl: string): Promise<string | undefined> => {
    let hostname: string;
    try { hostname = new URL(serverUrl).hostname; } catch { return Promise.resolve(undefined); }
    if (cache[hostname]) return Promise.resolve(cache[hostname]);
    // Misses stay memoized for the process lifetime to avoid re-probing on every refresh.
    if (!pending.has(hostname)) pending.set(hostname, lookup(serverUrl).catch(() => undefined));
    return pending.get(hostname)!;
  }, { cached, refresh });
}
