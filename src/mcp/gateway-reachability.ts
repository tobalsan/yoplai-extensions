import { isIP } from "node:net";

export type GatewayReachability = { public: boolean; reason: string };

const DOH_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];

const verdictCache = new Map<string, { expiresAt: number; verdict: GatewayReachability }>();

export function clearGatewayReachabilityCache(): void {
  verdictCache.clear();
}

function isNonPublicIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return isNonPublicIpv4(a, b);
  }
  if (family !== 6) return true;
  // URL canonicalizes expanded IPv6 and dotted IPv4 tails into hex groups.
  const canonical = new URL(`http://[${address.split("%")[0]}]`).hostname.slice(1, -1);
  if (canonical === "::" || canonical === "::1") return true;
  const mapped = /^::(?:ffff:)?([0-9a-f]+):[0-9a-f]+$/.exec(canonical);
  if (mapped) {
    const prefix = parseInt(mapped[1]!, 16);
    return isNonPublicIpv4(prefix >> 8, prefix & 255);
  }
  const prefix = parseInt(canonical, 16);
  return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80;
}

type DohAnswer = { type?: number; data?: string };

async function queryDoh(endpoint: string, hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
  const body = (await response.json()) as { Status?: number; Answer?: DohAnswer[] };
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new Error(`DoH status ${body.Status}`);
  const wanted = type === "A" ? DNS_TYPE_A : DNS_TYPE_AAAA;
  return (body.Answer ?? [])
    .filter((a) => a.type === wanted && typeof a.data === "string")
    .map((a) => a.data!);
}

async function resolvePublicDns(hostname: string): Promise<string[] | null> {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const [a, aaaa] = await Promise.all([
        queryDoh(endpoint, hostname, "A"),
        queryDoh(endpoint, hostname, "AAAA"),
      ]);
      return [...a, ...aaaa];
    } catch {
      // try next provider
    }
  }
  return null;
}

async function classify(hostname: string): Promise<GatewayReachability> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) {
    return isNonPublicAddress(literal)
      ? { public: false, reason: `IP literal ${literal} is in a non-public range` }
      : { public: true, reason: `IP literal ${literal} is public` };
  }
  const addresses = await resolvePublicDns(hostname);
  if (addresses === null) return { public: false, reason: "public DNS lookup failed" };
  if (addresses.length === 0) return { public: false, reason: "no public DNS A/AAAA records" };
  if (addresses.some((addr) => !isNonPublicAddress(addr))) return { public: true, reason: "public DNS returns a public address" };
  return { public: false, reason: "public DNS returns only non-public addresses" };
}

/** Whether a gateway hostname is reachable by name from the public internet. Verdicts are cached for 10 minutes. */
export async function checkGatewayReachability(hostname: string): Promise<GatewayReachability> {
  const key = hostname.toLowerCase().replace(/\.$/, "");
  const cached = verdictCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;
  const verdict = await classify(key);
  verdictCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, verdict });
  return verdict;
}
