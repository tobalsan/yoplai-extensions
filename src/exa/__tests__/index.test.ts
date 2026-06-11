import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";

import extension from "../index.js";
import { ExaConfigSchema } from "../models.js";

describe("exa extension", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the expected extension contract", () => {
    expect(extension.id).toBe("exa");
    expect(extension.displayName).toBe("Exa");
    expect(extension.description).toContain("Exa");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
  });

  it("parses config", () => {
    expect(ExaConfigSchema.parse({ apiKey: "secret" })).toEqual({ apiKey: "secret" });
  });

  function createTools() {
    return extension.createTools({
      global: {},
      agent: {},
      merged: {
        apiKey: "secret",
      },
    });
  }

  it("creates the expected tools with object parameter schemas", () => {
    const tools = createTools();

    expect(tools).toHaveLength(9);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      "code",
      "deep_search",
      "crawl",
      "company",
      "linkedin",
      "research_start",
      "research_check",
      "validate",
    ]);

    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
    }
  });

  it("rejects invalid params inside execute", async () => {
    const tools = createTools();
    const search = tools.find((tool) => tool.name === "search");

    await expect(search?.execute({ query: "exa", extra: true })).rejects.toThrow();
  });

  it("validate returns ok on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createTools();
    const validate = tools.find((tool) => tool.name === "validate");

    await expect(validate?.execute({})).resolves.toMatchObject({ ok: true });
  });

  it("validate throws ExaAuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createTools();
    const validate = tools.find((tool) => tool.name === "validate");

    const { ExaAuthError } = await import("../errors.js");
    await expect(validate?.execute({})).rejects.toBeInstanceOf(ExaAuthError);
  });

  it("returns taskId and a research_check instruction from research_start", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "task-1", status: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = createTools();
    const researchStart = tools.find((tool) => tool.name === "research_start");

    await expect(
      researchStart?.execute({ instructions: "Compare vector DBs" }),
    ).resolves.toMatchObject({
      taskId: "task-1",
      task: { id: "task-1", status: "running" },
      instruction: expect.stringContaining("exa_research_check"),
    });
  });
});
