import {
  FirecrawlAuthError,
  FirecrawlConnectionError,
  FirecrawlError,
  FirecrawlNotFoundError,
  FirecrawlRateLimitError,
  FirecrawlServerError,
  FirecrawlValidationError,
} from "./errors.js";
import {
  type CrawlCancelParams,
  type CrawlParams,
  type FirecrawlConfig,
  type MapParams,
  type MonitorParams,
  type ScrapeParams,
  type SearchParams,
} from "./models.js";

const MAX_PAGINATION_PAGES = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function extractRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? undefined;
}

function toLocation(country?: string, languages?: string[]): Record<string, unknown> | undefined {
  if (!country && !languages) {
    return undefined;
  }
  return compact({ country, languages });
}

function toScrapeOptions(
  formats?: string[],
  options?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!formats && !options) {
    return undefined;
  }
  return { ...(formats ? { formats } : {}), ...(options ?? {}) };
}

const REQUEST_TIMEOUT_BUFFER_MS = 5_000;

export interface FirecrawlClientOptions extends FirecrawlConfig {}

export class FirecrawlClient {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly baseUrl = "https://api.firecrawl.dev/v2";

  constructor(options: FirecrawlClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
  }

  async scrape(params: ScrapeParams): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "POST",
      "/scrape",
      compact({
        url: params.url,
        formats: params.formats,
        onlyMainContent: params.onlyMainContent,
        includeTags: params.includeTags,
        excludeTags: params.excludeTags,
        waitFor: params.waitFor,
        timeout: params.timeout,
        maxAge: params.maxAge,
        mobile: params.mobile,
        headers: params.headers,
        actions: params.actions,
        proxy: params.proxy,
        location: toLocation(params.country, params.languages),
        blockAds: params.blockAds,
        parsers: params.parsers,
      }),
      this.effectiveTimeoutMs(params.timeout),
    );
  }

  async search(params: SearchParams): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "POST",
      "/search",
      compact({
        query: params.query,
        limit: params.limit,
        sources: params.sources,
        categories: params.categories,
        tbs: params.tbs,
        location: params.location,
        country: params.country,
        timeout: params.timeout,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        ignoreInvalidURLs: params.ignoreInvalidURLs,
        scrapeOptions: toScrapeOptions(params.scrapeFormats, params.scrapeOptions),
      }),
      this.effectiveTimeoutMs(params.timeout),
    );
  }

  async map(params: MapParams): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "POST",
      "/map",
      compact({
        url: params.url,
        search: params.search,
        limit: params.limit,
        sitemap: params.sitemap,
        includeSubdomains: params.includeSubdomains,
        ignoreQueryParameters: params.ignoreQueryParameters,
        timeout: params.timeout,
        location: toLocation(params.country, params.languages),
      }),
      this.effectiveTimeoutMs(params.timeout),
    );
  }

  async crawl(params: CrawlParams): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "POST",
      "/crawl",
      compact({
        url: params.url,
        limit: params.limit,
        prompt: params.prompt,
        maxDiscoveryDepth: params.maxDiscoveryDepth,
        includePaths: params.includePaths,
        excludePaths: params.excludePaths,
        sitemap: params.sitemap,
        crawlEntireDomain: params.crawlEntireDomain,
        allowSubdomains: params.allowSubdomains,
        allowExternalLinks: params.allowExternalLinks,
        ignoreQueryParameters: params.ignoreQueryParameters,
        delay: params.delay,
        maxConcurrency: params.maxConcurrency,
        scrapeOptions: toScrapeOptions(params.scrapeFormats, params.scrapeOptions),
        webhook: params.webhook,
      }),
    );
  }

  async getCrawlStatus(params: MonitorParams): Promise<Record<string, unknown>> {
    const first = await this.requestJson("GET", `/crawl/${params.jobId}`);
    if (!params.autoPaginate) {
      return first;
    }
    const data = Array.isArray(first.data) ? [...first.data] : [];
    let next = typeof first.next === "string" ? first.next : undefined;
    let pages = 0;
    while (next && pages < MAX_PAGINATION_PAGES) {
      const page = await this.requestJson("GET", next);
      if (Array.isArray(page.data)) {
        data.push(...page.data);
      }
      next = typeof page.next === "string" ? page.next : undefined;
      pages += 1;
    }
    return { ...first, data, next: next ?? null };
  }

  async validate(): Promise<Record<string, unknown>> {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    try {
      await this.requestJson("GET", `/crawl/${fakeId}`);
      return { ok: true };
    } catch (error) {
      if (error instanceof FirecrawlNotFoundError) {
        return { ok: true };
      }
      throw error;
    }
  }

  async cancelCrawl(params: CrawlCancelParams): Promise<Record<string, unknown>> {
    return await this.requestJson("DELETE", `/crawl/${params.jobId}`);
  }

  private effectiveTimeoutMs(requestTimeoutMs?: number): number {
    return Math.max(this.timeoutMs, (requestTimeoutMs ?? 0) + REQUEST_TIMEOUT_BUFFER_MS);
  }

  private async requestJson(
    method: string,
    pathOrUrl: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(`${this.baseUrl}${pathOrUrl}`);
    const endpoint = url.pathname;
    const requestBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(requestBody ? { "Content-Type": "application/json" } : {}),
          },
          body: requestBody,
          signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        });

        const requestId = extractRequestId(response);

        if (response.status === 429) {
          if (attempt < 5) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
            continue;
          }
          throw new FirecrawlRateLimitError("Firecrawl rate limit exceeded", {
            endpoint,
            status: 429,
            requestId,
          });
        }

        if (response.status === 401 || response.status === 403) {
          const responseBody = await this.readResponseBody(response);
          throw new FirecrawlAuthError(
            `Firecrawl authentication failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
            { endpoint, status: response.status, requestId, responseBody },
          );
        }

        if (response.status === 404) {
          const responseBody = await this.readResponseBody(response);
          throw new FirecrawlNotFoundError(`Firecrawl resource not found: ${endpoint}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint,
            status: 404,
            requestId,
            responseBody,
          });
        }

        if (response.status === 400 || response.status === 409 || response.status === 422) {
          const responseBody = await this.readResponseBody(response);
          throw new FirecrawlValidationError(`Firecrawl request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        if (response.status >= 500) {
          if (attempt < 5) {
            await sleep(Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
            continue;
          }
          const responseBody = await this.readResponseBody(response);
          throw new FirecrawlServerError(
            `Firecrawl server error with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
            { endpoint, status: response.status, requestId, responseBody },
          );
        }

        if (!response.ok) {
          const responseBody = await this.readResponseBody(response);
          throw new FirecrawlError(`Firecrawl request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`, {
            endpoint,
            status: response.status,
            requestId,
            responseBody,
          });
        }

        const text = await response.text();
        if (!text) {
          return {};
        }
        return JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof FirecrawlError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new FirecrawlConnectionError(error.message, { endpoint });
        }
        throw error;
      }
    }

    throw new FirecrawlRateLimitError("Firecrawl rate limit exceeded", {
      endpoint,
      status: 429,
    });
  }

  private async readResponseBody(response: Response): Promise<string> {
    return (await response.text().catch(() => "")).slice(0, 500);
  }
}
