import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpServerConfig } from "./loader.js";

export interface McpToolDefinition {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientHandle {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type McpClientFactory = (server: McpServerConfig, accessToken?: string) => Promise<McpClientHandle>;
export type McpTokenProvider = (server: McpServerConfig) => Promise<string | undefined>;
export type McpNotConnectedResponse = (server: string) => unknown;

export interface McpServerError {
  server: string;
  message: string;
}

export class SdkMcpClientHandle implements McpClientHandle {
  private constructor(
    private readonly serverName: string,
    private readonly client: Client,
    private readonly transport: Transport
  ) {}

  static async connect(server: McpServerConfig, accessToken?: string): Promise<SdkMcpClientHandle> {
    const client = new Client({ name: "aihub-mcp", version: "0.1.0" });
    const transport = createTransport(server, accessToken);
    await client.connect(transport);
    return new SdkMcpClientHandle(server.name, client, transport);
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      server: this.serverName,
      name: tool.name,
      description: tool.description ?? `MCP tool ${tool.name} from ${this.serverName}`,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return await this.client.callTool({
      name,
      arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function createTransport(server: McpServerConfig, accessToken?: string): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
      stderr: "pipe",
    });
  }

  const headers = server.headers ? new Headers(server.headers) : accessToken ? new Headers({ Authorization: `Bearer ${accessToken}` }) : undefined;
  const requestInit = headers ? { headers } : undefined;
  if (server.url.includes("/sse")) {
    return new SSEClientTransport(new URL(server.url), {
      eventSourceInit: headers
        ? {
            fetch: (url, init) =>
              fetch(url, { ...init, headers: mergeHeaders(init.headers, headers) }),
          }
        : undefined,
      requestInit,
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
}

function mergeHeaders(
  base: HeadersInit | undefined,
  extra: Headers
): Headers {
  const headers = new Headers(base);
  for (const [key, value] of extra.entries()) headers.set(key, value);
  return headers;
}

export class McpClientManager {
  private readonly clients = new Map<string, McpClientHandle>();
  private readonly toolIndex = new Map<string, { server: string; tool: string }>();
  private readonly errors: McpServerError[] = [];

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly clientFactory: McpClientFactory = SdkMcpClientHandle.connect,
    private readonly tokenProvider?: McpTokenProvider,
    private readonly onAuthFailure?: (server: McpServerConfig) => Promise<void>,
    private readonly requiresOAuth?: (server: McpServerConfig) => Promise<boolean>,
    private readonly notConnectedResponse?: McpNotConnectedResponse
  ) {}

  async connect(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          const accessToken = server.type === "http" && !server.headers && this.tokenProvider
            ? await this.tokenProvider(server)
            : undefined;
          if (server.type === "http" && !server.headers && this.tokenProvider && await this.requiresOAuth?.(server) && !accessToken) {
            this.recordError(server.name, new Error("OAuth connection required"));
            return;
          }
          const client = await this.clientFactory(server, accessToken);
          this.clients.set(server.name, client);
        } catch (error) {
          if (isUnauthorized(error) && this.onAuthFailure) await this.onAuthFailure(server);
          this.recordError(server.name, error);
        }
      })
    );
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const groups = await Promise.all(
      [...this.clients.entries()].map(async ([server, client]) => {
        try {
          return await client.listTools();
        } catch (error) {
          const config = this.servers.find((item) => item.name === server);
          if (config && isUnauthorized(error) && this.onAuthFailure) await this.onAuthFailure(config);
          this.recordError(server, error);
          this.clients.delete(server);
          return [];
        }
      })
    );
    const tools = groups.flat();
    this.toolIndex.clear();
    for (const tool of tools) {
      this.toolIndex.set(`${tool.server}__${tool.name}`, {
        server: tool.server,
        tool: tool.name,
      });
    }
    return tools;
  }

  async invoke(namespacedToolName: string, args: unknown): Promise<unknown> {
    const target = this.toolIndex.get(namespacedToolName);
    if (!target) {
      throw new Error(`Unknown MCP tool "${namespacedToolName}"`);
    }
    return await this.invokeTool(target.server, target.tool, args);
  }

  async invokeTool(server: string, tool: string, args: unknown): Promise<unknown> {
    const client = this.clients.get(server);
    if (!client) {
      throw new Error(`MCP server "${server}" is not connected`);
    }
    try {
      return await client.callTool(tool, args);
    } catch (error) {
      const config = this.servers.find((item) => item.name === server);
      if (config && isUnauthorized(error) && this.onAuthFailure) await this.onAuthFailure(config);
      if (config && isUnauthorized(error) && this.notConnectedResponse) return this.notConnectedResponse(server);
      throw error;
    }
  }

  getErrors(): McpServerError[] {
    return [...this.errors];
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
    this.toolIndex.clear();
  }

  private recordError(server: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push({ server, message });
    console.warn(`[mcp] server "${server}" unavailable: ${message}`);
  }
}

function isUnauthorized(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthori[sz]ed/i.test(message);
}
