import {
  ExaAuthError,
  ExaConnectionError,
  ExaError,
  ExaNotFoundError,
  ExaRateLimitError,
  ExaServerError,
  ExaValidationError,
} from "./errors.js";
import {
  type CodeParams,
  type CompanyParams,
  type CrawlParams,
  type DeepSearchParams,
  type ExaConfig,
  type LinkedinParams,
  type ResearchCheckParams,
  type ResearchStartParams,
  type SearchParams,
} from "./models.js";

const DEFAULT_TIMEOUT_MS = 25_000;
const CODE_TIMEOUT_MS = 30_000;

const COMPANY_DOMAINS = [
  "bloomberg.com",
  "reuters.com",
  "crunchbase.com",
  "sec.gov",
  "linkedin.com",
  "forbes.com",
  "businesswire.com",
  "prnewswire.com",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linkedinQuery(query: string, type: LinkedinParams["type"]): string {
  if (type === "profiles") {
    return `${query} site:linkedin.com/in`;
  }
  if (type === "companies") {
    return `${query} site:linkedin.com/company`;
  }
  return query;
}

export interface ExaClientOptions extends ExaConfig {}

export class ExaClient {
  readonly apiKey: string;
  readonly baseUrl = "https://api.exa.ai";

  constructor(options: ExaClientOptions) {
    this.apiKey = options.apiKey;
  }

  async search(input: SearchParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query: input.query,
      numResults: input.numResults ?? 8,
      type: input.type ?? "auto",
      livecrawl: input.livecrawl ?? "fallback",
      contents: { maxCharacters: input.maxCharacters ?? 10_000 },
    });
  }

  async code(input: CodeParams): Promise<Record<string, unknown>> {
    const tokens = input.tokens ?? 5_000;
    if (tokens < 1_000 || tokens > 50_000) {
      throw new ExaValidationError(`tokens must be between 1000 and 50000, got ${tokens}`, {
        endpoint: "/context",
      });
    }
    return await this.requestJson(
      "POST",
      "/context",
      {
        query: input.query,
        tokens,
      },
      CODE_TIMEOUT_MS,
    );
  }

  async deepSearch(input: DeepSearchParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query: input.query,
      numResults: input.numResults ?? 8,
      type: "deep",
      contents: { maxCharacters: 10_000 },
    });
  }

  async crawl(input: CrawlParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/contents", {
      ids: [input.url],
      livecrawl: "always",
      text: { maxCharacters: input.maxCharacters ?? 3_000 },
    });
  }

  async company(input: CompanyParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query: input.company,
      numResults: input.numResults ?? 5,
      type: "auto",
      contents: { maxCharacters: 10_000 },
      includeDomains: COMPANY_DOMAINS,
    });
  }

  async linkedin(input: LinkedinParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/search", {
      query: linkedinQuery(input.query, input.type ?? "all"),
      numResults: input.numResults ?? 5,
      type: "auto",
      contents: { maxCharacters: 10_000 },
      includeDomains: ["linkedin.com"],
    });
  }

  async researchStart(input: ResearchStartParams): Promise<Record<string, unknown>> {
    return await this.requestJson("POST", "/research/v0/tasks", {
      instructions: input.instructions,
      model: input.model ?? "exa-research",
    });
  }

  async researchCheck(input: ResearchCheckParams): Promise<Record<string, unknown>> {
    return await this.requestJson("GET", `/research/v0/tasks/${input.taskId}`);
  }

  async validate(): Promise<Record<string, unknown>> {
    await this.requestJson("POST", "/search", {
      query: "test",
      numResults: 1,
    });
    return { ok: true, message: "Exa API reachable" };
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const requestBody = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "x-exa-integration": "exa-cli",
          },
          body: requestBody,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429) {
          if (attempt < 5) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "1");
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
            continue;
          }
          throw new ExaRateLimitError("Exa rate limit exceeded", {
            endpoint: path,
            status: 429,
          });
        }

        if (response.status >= 500) {
          if (attempt < 5) {
            await sleep(Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
            continue;
          }
          throw new ExaServerError(`Exa server error with status ${response.status}`, {
            endpoint: path,
            status: response.status,
          });
        }

        if (!response.ok) {
          const message = await this.readErrorMessage(response);
          const options = { endpoint: path, status: response.status };
          if (response.status === 401 || response.status === 403) {
            throw new ExaAuthError(message, options);
          }
          if (response.status === 404) {
            throw new ExaNotFoundError(message, options);
          }
          if (response.status === 400 || response.status === 409 || response.status === 422) {
            throw new ExaValidationError(message, options);
          }
          throw new ExaError(message, options);
        }

        const text = await response.text();
        if (!text) {
          return {};
        }
        return JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ExaError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new ExaConnectionError(error.message, { endpoint: path });
        }
        throw error;
      }
    }

    throw new ExaRateLimitError("Exa rate limit exceeded", { endpoint: path, status: 429 });
  }

  private async readErrorMessage(response: Response): Promise<string> {
    const fallback = response.statusText || `Exa request failed with status ${response.status}`;
    const text = await response.text();
    if (!text) {
      return fallback;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return typeof parsed.message === "string" && parsed.message.length > 0
        ? parsed.message
        : fallback;
    } catch {
      return fallback;
    }
  }
}
