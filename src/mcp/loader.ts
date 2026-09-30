import fs from "node:fs";
import { z } from "zod";

export type McpServerConfig =
  | {
      type: "stdio";
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Record<string, string>;
      oauth?: McpStaticOAuthClient;
    };

export interface McpStaticOAuthClient {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  errors: Array<{ server: string; message: string }>;
}

const StdioServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();

const HttpServerSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    oauth: z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

const RootSchema = z.object({
  mcpServers: z.record(z.unknown()),
});

function interpolateString(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) {
      throw new Error(`Env var "${name}" is not defined`);
    }
    return replacement;
  });
}

function interpolateValue(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") return interpolateString(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValue(item, env)])
    );
  }
  return value;
}

function parseServer(
  name: string,
  raw: unknown,
  env: Record<string, string>
): McpServerConfig {
  const interpolated = interpolateValue(raw, env);
  const http = HttpServerSchema.safeParse(interpolated);
  if (http.success) {
    return {
      type: "http",
      name,
      url: http.data.url,
      headers: http.data.headers,
      ...(http.data.oauth ? { oauth: http.data.oauth } : {}),
    };
  }

  const stdio = StdioServerSchema.safeParse(interpolated);
  if (stdio.success) {
    return {
      type: "stdio",
      name,
      command: stdio.data.command,
      args: stdio.data.args,
      env: stdio.data.env,
    };
  }

  throw new Error(
    `Server must define either { command } for stdio or { url } for HTTP/SSE`
  );
}

export function parseMcpConfig(
  rawJson: string,
  env: Record<string, string>
): LoadedMcpConfig {
  const parsedJson = JSON.parse(rawJson) as unknown;
  const root = RootSchema.parse(parsedJson);
  const servers: McpServerConfig[] = [];
  const errors: Array<{ server: string; message: string }> = [];

  for (const [name, rawServer] of Object.entries(root.mcpServers)) {
    try {
      servers.push(parseServer(name, rawServer, env));
    } catch (error) {
      errors.push({
        server: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { servers, errors };
}

export function loadMcpConfigFile(
  configPath: string,
  env: Record<string, string>
): LoadedMcpConfig {
  return parseMcpConfig(fs.readFileSync(configPath, "utf8"), env);
}
