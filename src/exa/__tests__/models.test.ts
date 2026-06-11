import { describe, expect, it } from "vitest";
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
} from "../models.js";

describe("exa models", () => {
  it("parses config", () => {
    expect(ExaConfigSchema.parse({ apiKey: "secret" })).toEqual({ apiKey: "secret" });
    expect(() => ExaConfigSchema.parse({})).toThrow();
  });

  it("parses tool parameter schemas", () => {
    expect(
      SearchParamsSchema.parse({
        query: "exa api",
        numResults: 5,
        type: "fast",
        livecrawl: "preferred",
        maxCharacters: 2000,
      }),
    ).toEqual({
      query: "exa api",
      numResults: 5,
      type: "fast",
      livecrawl: "preferred",
      maxCharacters: 2000,
    });
    expect(SearchParamsSchema.parse({ query: "exa api" })).toEqual({ query: "exa api" });
    expect(CodeParamsSchema.parse({ query: "zod transform", tokens: 2000 })).toEqual({
      query: "zod transform",
      tokens: 2000,
    });
    expect(DeepSearchParamsSchema.parse({ query: "state of LLM agents", numResults: 3 })).toEqual({
      query: "state of LLM agents",
      numResults: 3,
    });
    expect(CrawlParamsSchema.parse({ url: "https://example.com", maxCharacters: 500 })).toEqual({
      url: "https://example.com",
      maxCharacters: 500,
    });
    expect(CompanyParamsSchema.parse({ company: "Anthropic" })).toEqual({ company: "Anthropic" });
    expect(LinkedinParamsSchema.parse({ query: "Jane Doe", type: "profiles" })).toEqual({
      query: "Jane Doe",
      type: "profiles",
    });
    expect(
      ResearchStartParamsSchema.parse({
        instructions: "Compare vector databases",
        model: "exa-research-pro",
      }),
    ).toEqual({
      instructions: "Compare vector databases",
      model: "exa-research-pro",
    });
    expect(ResearchCheckParamsSchema.parse({ taskId: "task-1" })).toEqual({ taskId: "task-1" });
  });

  it("coerces stringified numbers", () => {
    expect(SearchParamsSchema.parse({ query: "exa", numResults: "5", maxCharacters: "1000" })).toEqual({
      query: "exa",
      numResults: 5,
      maxCharacters: 1000,
    });
    expect(CodeParamsSchema.parse({ query: "zod", tokens: "2000" })).toEqual({
      query: "zod",
      tokens: 2000,
    });
    expect(() => SearchParamsSchema.parse({ query: "exa", numResults: "not-a-number" })).toThrow();
  });

  it("rejects unknown keys and invalid enums on strict schemas", () => {
    expect(() => SearchParamsSchema.parse({ query: "exa", extra: true })).toThrow();
    expect(() => SearchParamsSchema.parse({ query: "exa", type: "neural" })).toThrow();
    expect(() => CodeParamsSchema.parse({ query: "zod", extra: true })).toThrow();
    expect(() => DeepSearchParamsSchema.parse({ query: "x", livecrawl: "fallback" })).toThrow();
    expect(() => CrawlParamsSchema.parse({ url: "https://example.com", extra: true })).toThrow();
    expect(() => CompanyParamsSchema.parse({ company: "Acme", extra: true })).toThrow();
    expect(() => LinkedinParamsSchema.parse({ query: "Jane", type: "people" })).toThrow();
    expect(() => ResearchStartParamsSchema.parse({ instructions: "x", model: "gpt-4" })).toThrow();
    expect(() => ResearchCheckParamsSchema.parse({ taskId: "task-1", extra: true })).toThrow();
  });

  it("rejects empty required strings", () => {
    expect(() => SearchParamsSchema.parse({ query: "" })).toThrow();
    expect(() => CrawlParamsSchema.parse({ url: "" })).toThrow();
    expect(() => ResearchStartParamsSchema.parse({ instructions: "" })).toThrow();
    expect(() => ResearchCheckParamsSchema.parse({ taskId: "" })).toThrow();
  });
});
