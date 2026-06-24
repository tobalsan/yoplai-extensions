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

export type McpClientFactory = (server: McpServerConfig) => Promise<McpClientHandle>;

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

  static async connect(server: McpServerConfig): Promise<SdkMcpClientHandle> {
    const client = new Client({ name: "aihub-mcp", version: "0.1.0" });
    const transport = createTransport(server);
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

function createTransport(server: McpServerConfig): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
      stderr: "pipe",
    });
  }

  const headers = server.headers ? new Headers(server.headers) : undefined;
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
    private readonly clientFactory: McpClientFactory = SdkMcpClientHandle.connect
  ) {}

  async connect(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          const client = await this.clientFactory(server);
          this.clients.set(server.name, client);
        } catch (error) {
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
    return await client.callTool(tool, args);
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
