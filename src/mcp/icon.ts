import fs from "node:fs";
import path from "node:path";
import { raceTimeout } from "./timeout.js";

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

  return (serverUrl: string): Promise<string | undefined> => {
    let hostname: string;
    try { hostname = new URL(serverUrl).hostname; } catch { return Promise.resolve(undefined); }
    if (cache[hostname]) return Promise.resolve(cache[hostname]);
    // Misses stay memoized for the process lifetime to avoid re-probing on every refresh.
    if (!pending.has(hostname)) pending.set(hostname, lookup(serverUrl).catch(() => undefined));
    return pending.get(hostname)!;
  };
}
