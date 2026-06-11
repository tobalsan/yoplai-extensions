import { ExaClient } from "./client.js";
import {
  CodeParamsSchema,
  CompanyParamsSchema,
  CrawlParamsSchema,
  DeepSearchParamsSchema,
  ExaConfigSchema,
  LinkedinParamsSchema,
  ResearchCheckParamsSchema,
  ResearchStartParamsSchema,
  SearchParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "exa",
  displayName: "Exa",
  description: "Exa web search: search, code context, deep search, crawling, company/LinkedIn lookups, and async research tasks.",
  systemPrompt: `Use this extension to search the web and gather sources with Exa. Pick exa_search for everyday lookups, exa_deep_search for thorough multi-faceted research objectives, exa_code for programming/library questions, and exa_crawl to read one specific URL. exa_company and exa_linkedin specialize in company and LinkedIn research. For long-running reports, start a task with exa_research_start and poll exa_research_check until it completes. Use exa_validate to check that the API key is valid and Exa is reachable.`,
  configSchema: ExaConfigSchema,
  requiredSecrets: ["apiKey"],
  createTools(config) {
    const resolved = ExaConfigSchema.parse(config.merged);
    const client = new ExaClient(resolved);

    return [
      {
        name: "search",
        description:
          "Search the web with Exa and get results with page text. Default choice for finding pages, facts, or recent information. Use exa_deep_search for complex research objectives and exa_code for programming questions.",
        parameters: SearchParamsSchema,
        execute: async (params) => {
          const parsed = SearchParamsSchema.parse(params);
          return await client.search(parsed);
        },
      },
      {
        name: "code",
        description:
          "Fetch programming-focused context (docs, code examples, API usage) for a coding question or library. Prefer this over exa_search for code, SDK, and library questions.",
        parameters: CodeParamsSchema,
        execute: async (params) => {
          const parsed = CodeParamsSchema.parse(params);
          return await client.code(parsed);
        },
      },
      {
        name: "deep_search",
        description:
          "Run a deep Exa search for a research objective. Slower but more thorough than exa_search; use for complex or multi-faceted questions that need broad source coverage.",
        parameters: DeepSearchParamsSchema,
        execute: async (params) => {
          const parsed = DeepSearchParamsSchema.parse(params);
          return await client.deepSearch(parsed);
        },
      },
      {
        name: "crawl",
        description:
          "Live-crawl a specific URL and return its page text. Use when you already know the exact page to read.",
        parameters: CrawlParamsSchema,
        execute: async (params) => {
          const parsed = CrawlParamsSchema.parse(params);
          return await client.crawl(parsed);
        },
      },
      {
        name: "company",
        description:
          "Research a company across curated business sources (Bloomberg, Reuters, Crunchbase, SEC, LinkedIn, Forbes, BusinessWire, PR Newswire).",
        parameters: CompanyParamsSchema,
        execute: async (params) => {
          const parsed = CompanyParamsSchema.parse(params);
          return await client.company(parsed);
        },
      },
      {
        name: "linkedin",
        description:
          "Search LinkedIn for people profiles and/or company pages.",
        parameters: LinkedinParamsSchema,
        execute: async (params) => {
          const parsed = LinkedinParamsSchema.parse(params);
          return await client.linkedin(parsed);
        },
      },
      {
        name: "research_start",
        description:
          "Start an asynchronous Exa research task that produces a written report. Returns a taskId; poll exa_research_check with it until status is \"completed\".",
        parameters: ResearchStartParamsSchema,
        execute: async (params) => {
          const parsed = ResearchStartParamsSchema.parse(params);
          const task = await client.researchStart(parsed);
          return {
            taskId: task.id,
            task,
            instruction:
              'Research runs asynchronously. Poll exa_research_check with this taskId until status is "completed" (report in data.report) or "failed".',
          };
        },
      },
      {
        name: "research_check",
        description:
          "Check the status of a research task started with exa_research_start. When status is \"completed\", the report is in data.report.",
        parameters: ResearchCheckParamsSchema,
        execute: async (params) => {
          const parsed = ResearchCheckParamsSchema.parse(params);
          return await client.researchCheck(parsed);
        },
      },
      {
        name: "validate",
        description: "Validate configuration and API reachability.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
    ];
  },
});
