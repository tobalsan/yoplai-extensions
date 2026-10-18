import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineToolExtension, expandTypeArrays } from "./tool-extension.js";

function createDefinition(overrides: Record<string, unknown> = {}) {
  const createTools = vi.fn((config) => [
    {
      name: "lookup",
      description: `Lookup for ${String(config.merged.region)}`,
      parameters: z.object({ query: z.string() }),
      execute: async (params: unknown) => params,
    },
    {
      name: "example_ready",
      description: "Already mounted",
      parameters: z.object({}),
      execute: async () => "ready",
    },
  ]);

  return {
    createTools,
    extension: defineToolExtension({
      id: "example",
      displayName: "Example",
      description: "Example tools",
      systemPrompt: " Use example tools. ",
      configSchema: z.object({ apiKey: z.string(), region: z.string() }),
      agentConfigSchema: z.object({ region: z.string() }),
      requiredSecrets: ["apiKey"],
      createTools,
      ...overrides,
    }),
  };
}

describe("defineToolExtension", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opts in per agent and resolves merged root and agent config", async () => {
    vi.stubEnv("EXAMPLE_API_KEY", "secret");
    const { createTools, extension } = createDefinition();
    const agent = {
      id: "agent-1",
      extensions: { example: { enabled: true, region: "eu" } },
    };
    const context = {
      config: {
        extensions: {
          example: {
            enabled: true,
            apiKey: "$env:EXAMPLE_API_KEY",
            region: "us",
          },
        },
      },
    };

    const tools = await extension.getAgentTools(agent, context);

    expect(tools.map((tool) => tool.name)).toEqual([
      "example_lookup",
      "example_ready",
    ]);
    expect(createTools).toHaveBeenCalledWith({
      global: { apiKey: "secret", region: "us" },
      root: { apiKey: "secret", region: "us" },
      agent: { region: "eu" },
      merged: { apiKey: "secret", region: "eu" },
      oauth: undefined,
    });
    expect(tools[0]?.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
    await expect(tools[0]?.execute({ query: "status" })).resolves.toEqual({
      query: "status",
    });
  });

  it("does not construct tools for absent or disabled agent config", async () => {
    const { createTools, extension } = createDefinition();
    const context = {
      config: {
        extensions: { example: { apiKey: "secret", region: "us" } },
      },
    };

    await expect(
      extension.getAgentTools({ id: "absent" }, context)
    ).resolves.toEqual([]);
    await expect(
      extension.getAgentTools(
        { id: "disabled", extensions: { example: { enabled: false } } },
        context
      )
    ).resolves.toEqual([]);
    expect(createTools).not.toHaveBeenCalled();
  });

  it("reports schema, env, and required-secret failures during validation", () => {
    const { extension } = createDefinition();
    const unresolvedEnv = extension.validateAgentConfigs({
      extensions: {
        example: { apiKey: "$env:MISSING_EXAMPLE_KEY", region: "us" },
      },
      agents: [{ id: "env", extensions: { example: { region: "eu" } } }],
    });
    const invalidSchema = extension.validateAgentConfigs({
      agents: [
        { id: "bad-schema", extensions: { example: { region: 42 } } },
      ],
    });
    const { extension: optionalSecretExtension } = createDefinition({
      configSchema: z.object({ apiKey: z.string().optional(), region: z.string() }),
    });
    const missingSecret = optionalSecretExtension.validateAgentConfigs({
      agents: [
        { id: "missing-secret", extensions: { example: { region: "eu" } } },
      ],
    });

    expect(unresolvedEnv.valid).toBe(false);
    expect(unresolvedEnv.errors[0]).toContain(
      'Env var "MISSING_EXAMPLE_KEY" not set'
    );
    expect(invalidSchema.valid).toBe(false);
    expect(invalidSchema.errors[0]).toContain("Expected string");
    expect(missingSecret.valid).toBe(false);
    expect(missingSecret.errors[0]).toContain(
      'missing required secret "apiKey"'
    );
  });

  it("keeps prompt guidance without constructing a catalog and resolves OAuth through tool registration", async () => {
    const oauth = {
      connected: true as const,
      provider: "google",
      accessToken: "fresh-token",
      scopes: ["scope"],
    };
    const resolveOAuth = vi.fn().mockResolvedValue(oauth);
    const { createTools, extension } = createDefinition({
      oauth: { provider: "google", scopes: ["scope"] },
    });
    const agent = {
      id: "agent-1",
      extensions: { example: { region: "eu" } },
    };
    const context = {
      config: { extensions: { example: { apiKey: "secret" } } },
      resolveOAuth,
    };

    const prompts = await extension.getSystemPromptContributions(agent, context);

    expect(resolveOAuth).toHaveBeenCalledWith(agent, {
      provider: "google",
      scopes: ["scope"],
    }, undefined);
    expect(createTools).not.toHaveBeenCalled();
    expect(prompts).toEqual(["Use example tools."]);

    const tools = await extension.getAgentTools(agent, context);
    expect(tools.map((tool) => tool.name)).toEqual(["example_lookup", "example_ready"]);
    expect(createTools).toHaveBeenCalledWith(expect.objectContaining({ oauth }));
    await expect(tools[0]?.execute({ query: "status" })).resolves.toEqual({ query: "status" });
  });

  it("resolves OAuth for the requesting user at build and call time", async () => {
    const resolveOAuth = vi.fn().mockResolvedValue({
      connected: true as const,
      provider: "google",
      accessToken: "user-token",
      scopes: [],
    });
    const { extension } = createDefinition({
      oauth: { provider: "google" },
    });
    const agent = { id: "agent-1", extensions: { example: { region: "eu" } } };
    const context = {
      config: { extensions: { example: { apiKey: "secret" } } },
      userId: "user-a",
      resolveOAuth,
    };

    const tools = await extension.getAgentTools(agent, context);
    expect(resolveOAuth).toHaveBeenLastCalledWith(agent, { provider: "google" }, "user-a");

    await tools[0]?.execute({ query: "q" }, { userId: "user-b" });
    expect(resolveOAuth).toHaveBeenLastCalledWith(agent, { provider: "google" }, "user-b");
  });

  it("uses structured disconnected OAuth and preserves adapter JSON Schema", async () => {
    const rawSchema = {
      type: "object",
      properties: { dynamic: { type: "number" } },
    };
    const { createTools, extension } = createDefinition({
      oauth: { provider: "google" },
      createTools: vi.fn((config) => [
        {
          name: "dynamic",
          description: "Dynamic adapter tool",
          parameters: z.object({}).passthrough(),
          jsonSchemaParameters: rawSchema,
          execute: async () => config.oauth,
        },
      ]),
    });

    const tools = await extension.getAgentTools(
      { id: "agent-1", extensions: { example: { region: "eu" } } },
      { config: { extensions: { example: { apiKey: "secret" } } } }
    );

    expect(tools[0]?.parameters).toEqual(rawSchema);
    await expect(tools[0]?.execute({})).resolves.toEqual({
      connected: false,
      provider: "google",
      reason: "provider_not_configured",
      message: 'OAuth provider "google" is not configured on this host.',
    });
    expect(createTools).not.toHaveBeenCalled();
  });
});

describe("expandTypeArrays", () => {
  it("rewrites primitive type arrays to anyOf, keeping property names", () => {
    expect(
      expandTypeArrays({
        type: "object",
        properties: {
          id: { type: ["string", "number"] },
          type: { type: "string", enum: ["a"] },
          lines: { type: "array", items: { type: "object", properties: { qty: { type: ["string", "number"] } } } },
        },
      })
    ).toEqual({
      type: "object",
      properties: {
        id: { anyOf: [{ type: "string" }, { type: "number" }] },
        type: { type: "string", enum: ["a"] },
        lines: {
          type: "array",
          items: { type: "object", properties: { qty: { anyOf: [{ type: "string" }, { type: "number" }] } } },
        },
      },
    });
  });
});

describe("tool result declarations", () => {
  it("publishes no-ref result fields while leaving legacy tools and refusal payloads usable", async () => {
    const address = z.object({ city: z.string() });
    const extension = defineToolExtension({
      id: "results", displayName: "Results", description: "Results",
      configSchema: z.object({}), requiredSecrets: [],
      createTools: () => [
        { name: "declared", description: "Declared", parameters: z.object({}),
          outputSchema: z.object({ primary: address, secondary: address }),
          execute: async () => ({ isError: true, message: "Connect account" }) },
        { name: "legacy", description: "Legacy", parameters: z.object({}), execute: async () => "legacy" },
      ],
    });
    const [declared, legacy] = await extension.getAgentTools({ id: "a", extensions: { results: {} } }, { config: {} });
    expect(declared).toMatchObject({ outputSchema: {
      type: "object", required: ["primary", "secondary"], properties: {
        primary: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        secondary: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    } });
    expect(legacy).not.toHaveProperty("outputSchema");
    await expect(declared!.execute({})).resolves.toEqual({ isError: true, message: "Connect account" });
    await expect(legacy!.execute({})).resolves.toBe("legacy");
  });
});
