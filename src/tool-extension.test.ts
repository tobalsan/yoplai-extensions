import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineToolExtension } from "./tool-extension.js";

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

  it("injects host OAuth resolution into tools and prompt construction", async () => {
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
    });
    expect(createTools).toHaveBeenCalledWith(
      expect.objectContaining({ oauth })
    );
    expect(prompts).toEqual([
      "Use example tools.",
      [
        "Yoplai exposes this extension's tools with these exact names:",
        "- example_lookup: Lookup for eu",
        "- example_ready: Already mounted",
      ].join("\n"),
    ]);
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

    expect(tools[0]?.parameters).toBe(rawSchema);
    await expect(tools[0]?.execute({})).resolves.toEqual({
      connected: false,
      provider: "google",
      reason: "provider_not_configured",
      message: 'OAuth provider "google" is not configured on this host.',
    });
    expect(createTools).not.toHaveBeenCalled();
  });
});
