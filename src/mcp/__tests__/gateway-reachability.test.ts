import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkGatewayReachability,
  clearGatewayReachabilityCache,
} from "../gateway-reachability.js";

type Records = Record<string, { status?: number; answers?: { type: number; data: string }[] } | "fail">;

function mockDoh(byProvider: { cloudflare: Records; google?: Records }) {
  const mock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const records = url.hostname === "cloudflare-dns.com" ? byProvider.cloudflare : byProvider.google;
    const type = url.searchParams.get("type")!;
    const entry = records?.[type] ?? "fail";
    if (entry === "fail") throw new Error("network down");
    return new Response(JSON.stringify({ Status: entry.status ?? 0, Answer: entry.answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const a = (data: string) => ({ type: 1, data });
const aaaa = (data: string) => ({ type: 28, data });

async function verdictFor(v4: string[], v6: string[] = []) {
  mockDoh({ cloudflare: { A: { answers: v4.map(a) }, AAAA: { answers: v6.map(aaaa) } } });
  return checkGatewayReachability("gw.example.test");
}

describe("checkGatewayReachability", () => {
  beforeEach(() => clearGatewayReachabilityCache());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
    "100.99.1.2", "100.127.255.255", "127.0.0.1", "169.254.1.1", "0.0.0.0",
  ])("treats IPv4 %s as private", async (ip) => {
    expect((await verdictFor([ip])).public).toBe(false);
  });

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "100.63.0.1", "192.169.0.1"])(
    "treats IPv4 %s as public",
    async (ip) => {
      expect((await verdictFor([ip])).public).toBe(true);
    },
  );

  it.each(["::1", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "febf::1", "::ffff:10.0.0.1", "::ffff:100.64.0.1", "::ffff:7f00:1"])(
    "treats IPv6 %s as private",
    async (ip) => {
      expect((await verdictFor([], [ip])).public).toBe(false);
    },
  );

  it.each(["2606:4700::1111", "fec0::1", "::ffff:8.8.8.8"])("treats IPv6 %s as public", async (ip) => {
    expect((await verdictFor([], [ip])).public).toBe(true);
  });

  it("treats NXDOMAIN and empty answers as private", async () => {
    mockDoh({ cloudflare: { A: { status: 3 }, AAAA: { status: 3 } } });
    expect((await checkGatewayReachability("gw.example.test")).public).toBe(false);
  });

  it("is public when public and private answers are mixed", async () => {
    expect((await verdictFor(["100.64.0.1", "93.184.216.34"])).public).toBe(true);
  });

  it("follows CNAME chains and judges only A/AAAA records", async () => {
    mockDoh({
      cloudflare: {
        A: { answers: [{ type: 5, data: "8.8.8.8" }, a("100.64.0.9")] },
        AAAA: {},
      },
    });
    expect((await checkGatewayReachability("gw.example.test")).public).toBe(false);
  });

  it("is public for a CNAME resolving to a public address", async () => {
    mockDoh({
      cloudflare: { A: { answers: [{ type: 5, data: "edge.example.test." }, a("93.184.216.34")] }, AAAA: {} },
    });
    expect((await checkGatewayReachability("gw.example.test")).public).toBe(true);
  });

  it("falls back to Google DoH when Cloudflare fails", async () => {
    const mock = mockDoh({
      cloudflare: { A: "fail", AAAA: "fail" },
      google: { A: { answers: [a("93.184.216.34")] }, AAAA: {} },
    });
    expect((await checkGatewayReachability("gw.example.test")).public).toBe(true);
    const hosts = mock.mock.calls.map(([u]) => new URL(String(u)).hostname);
    expect(hosts).toContain("dns.google");
  });

  it("sends the dns-json accept header", async () => {
    const mock = mockDoh({ cloudflare: { A: {}, AAAA: {} } });
    await checkGatewayReachability("gw.example.test");
    expect((mock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Accept: "application/dns-json" });
  });

  it("is private when both providers fail", async () => {
    mockDoh({ cloudflare: { A: "fail", AAAA: "fail" }, google: { A: "fail", AAAA: "fail" } });
    const verdict = await checkGatewayReachability("gw.example.test");
    expect(verdict.public).toBe(false);
    expect(verdict.reason).toMatch(/failed/);
  });

  it("falls back to private after both providers time out", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn((_input: string, { signal }: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const verdict = checkGatewayReachability("gw.example.test");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(verdict).resolves.toMatchObject({ public: false, reason: "public DNS lookup failed" });
  });

  it("is private on non-OK HTTP responses from both providers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect((await checkGatewayReachability("gw.example.test")).public).toBe(false);
  });

  it("judges IP literals directly without DNS", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await checkGatewayReachability("100.64.1.1")).public).toBe(false);
    expect((await checkGatewayReachability("93.184.216.34")).public).toBe(true);
    expect((await checkGatewayReachability("[fd7a:115c:a1e0::1]")).public).toBe(false);
    expect((await checkGatewayReachability("::ffff:192.168.0.1")).public).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches verdicts per hostname for 10 minutes", async () => {
    vi.useFakeTimers();
    const mock = mockDoh({ cloudflare: { A: { answers: [a("93.184.216.34")] }, AAAA: {} } });
    await checkGatewayReachability("gw.example.test");
    const calls = mock.mock.calls.length;
    await checkGatewayReachability("GW.example.test");
    expect(mock.mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    await checkGatewayReachability("gw.example.test");
    expect(mock.mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(2);
    await checkGatewayReachability("gw.example.test");
    expect(mock.mock.calls.length).toBe(calls * 2);
  });
});
