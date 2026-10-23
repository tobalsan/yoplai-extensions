import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { classifyMcpError, isUnauthorized, type McpErrorCategory } from "./errors.js";
import type { McpServerConfig } from "./loader.js";
import { logMcpUnavailable, type McpLogContext, type McpLogEvent, type McpLogLevel } from "./logging.js";
import { withTimeout as withDeadline } from "./timeout.js";

const withTimeout = <T>(task: Promise<T>, message: string): Promise<T> => withDeadline(task, 10_000, message);

export interface McpToolDefinition {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpServerLabel = { title?: string; description?: string };

const MAX_TITLE_LENGTH = 40;

/**
 * Short title + description from initialize `serverInfo`. Some servers stuff a sentence into `title`
 * (e.g. "Claap Meeting Recording Platform: Browse meetings…"); split it at the first ":" / " - " / " — ".
 */
export function labelFromServerInfo(info: { name?: string; title?: string; description?: string } | undefined): McpServerLabel {
  let title = info?.title?.trim() || undefined;
  let description = info?.description?.trim() || undefined;
  if (!title) {
    const name = info?.name?.trim();
    // `name` is often a slug ("github-mcp-server"); only use it when it reads like a label.
    if (name && /[A-Z ]/.test(name) && !/[_-]/.test(name)) title = name;
  }
  if (title && title.length > MAX_TITLE_LENGTH) {
    const match = title.match(/^(.{2,40}?)\s*(?::|\s[-—–]\s)\s*(.+)$/);
    if (match) {
      title = match[1];
      description ??= match[2];
    } else {
      description ??= title;
      title = undefined;
    }
  }
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

export interface McpClientHandle {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  getServerIcon?(): string | undefined;
  getServerInfo?(): McpServerLabel;
  getInstructions?(): string | undefined;
}

export type McpRequestTokenProvider = (termination?: boolean) => Promise<string | undefined>;
export type McpClientFactory = (server: McpServerConfig, accessToken?: string, tokenProvider?: McpRequestTokenProvider) => Promise<McpClientHandle>;
export interface McpTokenResult {
  error?: { category: McpErrorCategory; message: string };
  token?: string;
  reason?: "not_connected" | "needs_reconnect" | "refresh_failed";
  scope?: "personal" | "team";
}
export type McpTokenProvider = (server: McpServerConfig, termination?: boolean) => Promise<string | McpTokenResult | undefined>;
type McpAuthRecovery = (server: McpServerConfig) => Promise<boolean | McpTokenResult>;
export type McpNotConnectedResponse = (server: string) => unknown;

export interface McpClientManagerOptions {
  preserveSessionOnAuthRecovery?: boolean;
  statusOnly?: boolean;
  logContext?: McpLogContext;
  logUnavailable?: (level: McpLogLevel, message: string, event: McpLogEvent) => void;
  onConnected?: (server: string) => void;
  clientFactory?: McpClientFactory;
  tokenProvider?: McpTokenProvider;
  onAuthFailure?: McpAuthRecovery;
  requiresOAuth?: (server: McpServerConfig) => Promise<boolean>;
  notConnectedResponse?: McpNotConnectedResponse;
  onUnrecoverableAuthFailure?: (server: McpServerConfig) => Promise<void>;
}

export interface McpServerError {
  server: string;
  message: string;
  category?: McpErrorCategory;
}

export class SdkMcpClientHandle implements McpClientHandle {
  private constructor(
    private readonly serverName: string,
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly oauthHttp: boolean
  ) {}

  static async connect(server: McpServerConfig, accessToken?: string, statusOnly: boolean | McpRequestTokenProvider = false, tokenProvider?: McpRequestTokenProvider): Promise<SdkMcpClientHandle> {
    if (typeof statusOnly === "function") { tokenProvider = statusOnly; statusOnly = false; }
    const client = new Client({ name: "yoplai-mcp", version: "0.1.0" });
    const transport = createTransport(server, accessToken, tokenProvider);
    const handle = new SdkMcpClientHandle(server.name, client, transport, server.type === "http" && !server.headers && Boolean(tokenProvider || accessToken));
    try {
      await withTimeout(client.connect(transport), `MCP server "${server.name}" connection timed out`);
    } catch (error) {
      if (statusOnly) {
        void withTimeout(handle.close(), `MCP server "${server.name}" close timed out`).catch(() => {});
        throw error;
      }
      try { await withTimeout(handle.close(), `MCP server "${server.name}" close timed out`); }
      catch { /* The original connection error is more useful. */ }
      throw error;
    }
    return handle;
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

  async callTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    return await this.client.callTool({
      name,
      arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
    }, undefined, { signal: options?.signal });
  }

  getServerIcon(): string | undefined {
    return this.client.getServerVersion()?.icons?.[0]?.src;
  }

  getServerInfo(): McpServerLabel {
    return labelFromServerInfo(this.client.getServerVersion());
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions()?.trim() || undefined;
  }

  async terminateSession(): Promise<void> {
    if (this.oauthHttp && this.transport instanceof StreamableHTTPClientTransport) await this.transport.terminateSession();
  }

  async close(): Promise<void> {
    try { await withDeadline(this.terminateSession(), 5_000, `MCP server "${this.serverName}" session end timed out`); }
    catch (error) {
      logMcpUnavailable("warn", error instanceof Error ? error.message : String(error), { agentId: "unknown", path: "call", server: this.serverName, reason: "session_end_failed" });
    }
    finally { await this.transport.close(); }
  }
}

function createTransport(server: McpServerConfig, accessToken?: string, tokenProvider?: McpRequestTokenProvider): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
      stderr: "pipe",
    });
  }

  const headers = server.headers ? new Headers(server.headers) : !tokenProvider && accessToken ? new Headers({ Authorization: `Bearer ${accessToken}` }) : undefined;
  const requestInit = headers ? { headers } : undefined;
  let sessionToken = accessToken;
  const authenticatedFetch: typeof fetch | undefined = !server.headers && tokenProvider ? async (url, init) => {
    let token: string | undefined;
    try { token = await tokenProvider(init?.method === "DELETE"); }
    catch (error) { if (init?.method !== "DELETE") throw error; }
    // Only cleanup may use the last session token after the pinned grant is invalidated.
    if (!token && init?.method === "DELETE") token = sessionToken;
    if (!token) throw Object.assign(new Error("OAuth connection required"), { code: 401 });
    sessionToken = token;
    return fetch(url, { ...init, headers: mergeHeaders(init?.headers, new Headers({ Authorization: `Bearer ${token}` })) });
  } : undefined;
  if (server.url.includes("/sse")) {
    return new SSEClientTransport(new URL(server.url), {
      fetch: authenticatedFetch,
      eventSourceInit: authenticatedFetch ? { fetch: authenticatedFetch } : headers
        ? {
            fetch: (url, init) =>
              fetch(url, { ...init, headers: mergeHeaders(init.headers, headers) }),
          }
        : undefined,
      requestInit,
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit, fetch: authenticatedFetch });
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
  private readonly logContext: McpLogContext;
  private readonly logUnavailable: typeof logMcpUnavailable;
  private readonly onConnected?: (server: string) => void;
  private readonly tokenResults = new Map<string, McpTokenResult>();
  private readonly clients = new Map<string, McpClientHandle>();
  private readonly toolIndex = new Map<string, { server: string; tool: string }>();
  private readonly errors: McpServerError[] = [];
  private readonly recoveries = new Map<string, Promise<boolean>>();
  private readonly authVersions = new Map<string, number>();
  private connecting?: Promise<void>;

  private readonly clientFactory: McpClientFactory;
  private readonly tokenProvider?: McpTokenProvider;
  private readonly onAuthFailure?: McpAuthRecovery;
  private readonly requiresOAuth?: (server: McpServerConfig) => Promise<boolean>;
  private readonly notConnectedResponse?: McpNotConnectedResponse;
  private readonly onUnrecoverableAuthFailure?: (server: McpServerConfig) => Promise<void>;

  constructor(private readonly servers: McpServerConfig[], private readonly options: McpClientManagerOptions = {}) {
    this.logContext = options.logContext ?? { agentId: "unknown", path: "tools" };
    this.logUnavailable = options.logUnavailable ?? logMcpUnavailable;
    this.onConnected = options.onConnected;
    this.clientFactory = options.clientFactory ?? ((server, token, provider) => SdkMcpClientHandle.connect(server, token, options.statusOnly, provider));
    this.tokenProvider = options.tokenProvider;
    this.onAuthFailure = options.onAuthFailure;
    this.requiresOAuth = options.requiresOAuth;
    this.notConnectedResponse = options.notConnectedResponse;
    this.onUnrecoverableAuthFailure = options.onUnrecoverableAuthFailure;
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = Promise.all(
      this.servers.filter((server) => !this.clients.has(server.name)).map(async (server) => {
        try {
          await this.connectServer(server);
        } catch (error) {
          if (!(error instanceof OAuthConnectionRequired) && (this.options.statusOnly ? classifyMcpError(error) === "authentication" : isUnauthorized(error))) {
            if (this.options.statusOnly) error = await this.statusAuthFailure(server, error);
            else if (await this.recover(server)) return;
          }
          this.recordError(server.name, error);
        }
      })
    ).then(() => undefined);
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private async connectServer(server: McpServerConfig): Promise<void> {
    const provided = server.type === "http" && !server.headers && this.tokenProvider
      ? await this.tokenProvider(server)
      : undefined;
    const result = typeof provided === "string" ? { token: provided } : provided;
    this.tokenResults.set(server.name, result ?? {});
    const accessToken = result?.token;
    if (server.type === "http" && !server.headers && this.tokenProvider && await this.requiresOAuth?.(server) && !accessToken) {
      throw new OAuthConnectionRequired(result?.reason ?? "not_connected", result?.error);
    }
    const requestToken = this.options.preserveSessionOnAuthRecovery && this.tokenProvider
      ? async (termination?: boolean) => {
          const provided = await this.tokenProvider!(server, termination);
          return typeof provided === "string" ? provided : provided?.token;
        }
      : undefined;
    const pending = this.clientFactory(server, accessToken, requestToken);
    let timedOut = false;
    void pending.then((client) => { if (timedOut) return withTimeout(client.close(), `MCP server "${server.name}" close timed out`); }).catch(() => {});
    const client = await withTimeout(pending, `MCP server "${server.name}" connection timed out`).catch((error: unknown) => {
      timedOut = true;
      throw error;
    });
    this.clients.set(server.name, client);
    this.onConnected?.(server.name);
  }

  private async statusAuthFailure(server: McpServerConfig, error: unknown): Promise<unknown> {
    const result = await this.onAuthFailure?.(server);
    if (result && typeof result !== "boolean") {
      this.tokenResults.set(server.name, result);
      if (result.error) return new OAuthConnectionRequired(result.reason ?? "refresh_failed", result.error);
    }
    return error;
  }

  private async recover(server: McpServerConfig): Promise<boolean> {
    const activeRecovery = this.recoveries.get(server.name);
    if (activeRecovery) return activeRecovery;
    const recovery = this.recoverServer(server);
    this.recoveries.set(server.name, recovery);
    try {
      return await recovery;
    } finally {
      this.recoveries.delete(server.name);
    }
  }

  private async recoverServer(server: McpServerConfig): Promise<boolean> {
    if (!this.onAuthFailure) return false;
    const recovery = await this.onAuthFailure(server);
    if (typeof recovery !== "boolean") this.tokenResults.set(server.name, recovery);
    if (typeof recovery === "boolean" ? !recovery : !recovery.token) return false;
    if (this.options.preserveSessionOnAuthRecovery && this.clients.has(server.name)) {
      this.authVersions.set(server.name, (this.authVersions.get(server.name) ?? 0) + 1);
      return true;
    }
    const client = this.clients.get(server.name);
    this.clients.delete(server.name);
    if (client) {
      try {
        await withTimeout(client.close(), `MCP server "${server.name}" close timed out`);
      } catch (error) {
        this.recordError(server.name, error);
      }
    }
    try {
      await this.connectServer(server);
      return true;
    } catch (error) {
      if (isUnauthorized(error)) await this.onUnrecoverableAuthFailure?.(server);
      this.recordError(server.name, error, isUnauthorized(error) ? "unrecoverable_auth" : "transport_failed");
      return false;
    }
  }

  private async discardClient(server: string, client: McpClientHandle): Promise<void> {
    if (this.clients.get(server) === client) this.clients.delete(server);
    try {
      await withTimeout(client.close(), `MCP server "${server}" close timed out`);
    } catch (error) {
      this.recordError(server, error);
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const groups = await Promise.all(
      [...this.clients.entries()].map(async ([server, client]) => {
        try {
          return await withTimeout(client.listTools(), `MCP server "${server}" tool listing timed out`);
        } catch (error) {
          const config = this.servers.find((item) => item.name === server);
          if (config && this.options.statusOnly && classifyMcpError(error) === "authentication") error = await this.statusAuthFailure(config, error);
          if (config && isUnauthorized(error) && !this.options.statusOnly && await this.recover(config)) {
            const refreshed = this.clients.get(server);
            if (refreshed) {
              try {
                return await withTimeout(refreshed.listTools(), `MCP server "${server}" tool listing timed out`);
              } catch (retryError) {
                if (isUnauthorized(retryError)) await this.onUnrecoverableAuthFailure?.(config);
                this.recordError(server, retryError, isUnauthorized(retryError) ? "unrecoverable_auth" : "transport_failed");
                await this.discardClient(server, refreshed);
                return [];
              }
            }
          }
          this.recordError(server, error);
          if (this.options.statusOnly) {
            this.clients.delete(server);
            void withTimeout(client.close(), `MCP server "${server}" close timed out`).catch(() => {});
            return [];
          }
          try {
            await withTimeout(client.close(), `MCP server "${server}" close timed out`);
          } catch (closeError) {
            this.recordError(server, closeError);
          } finally {
            this.clients.delete(server);
          }
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

  hasClient(server: string): boolean {
    return this.clients.has(server);
  }

  getServerIcon(server: string): string | undefined {
    return this.clients.get(server)?.getServerIcon?.();
  }

  getInstructions(server: string): string | undefined {
    return this.clients.get(server)?.getInstructions?.();
  }

  getServerInfo(server: string): McpServerLabel {
    return this.clients.get(server)?.getServerInfo?.() ?? {};
  }

  async invoke(namespacedToolName: string, args: unknown): Promise<unknown> {
    const target = this.toolIndex.get(namespacedToolName);
    if (!target) {
      throw new Error(`Unknown MCP tool "${namespacedToolName}"`);
    }
    return await this.invokeTool(target.server, target.tool, args);
  }

  async invokeTool(server: string, tool: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error("MCP call cancelled");
    const client = this.clients.get(server);
    if (!client) {
      throw new Error(`MCP server "${server}" is not connected`);
    }
    const authVersion = this.authVersions.get(server) ?? 0;
    try {
      return await client.callTool(tool, args, options);
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason ?? error;
      const config = this.servers.find((item) => item.name === server);
      if (config && isUnauthorized(error)) {
        if ((this.options.preserveSessionOnAuthRecovery && authVersion !== (this.authVersions.get(server) ?? 0)) || await this.recover(config)) {
          const refreshed = this.clients.get(server);
          if (refreshed) {
            try {
              if (options?.signal?.aborted) throw options.signal.reason ?? new Error("MCP call cancelled");
              return await refreshed.callTool(tool, args, options);
            } catch (retryError) {
              if (options?.signal?.aborted) throw options.signal.reason ?? retryError;
              if (isUnauthorized(retryError)) {
                await this.onUnrecoverableAuthFailure?.(config);
                this.recordError(server, retryError, "unrecoverable_auth");
                await this.discardClient(server, refreshed);
                if (this.notConnectedResponse) return this.notConnectedResponse(server);
              }
              throw retryError;
            }
          }
        }
        if (this.options.preserveSessionOnAuthRecovery) {
          await this.onUnrecoverableAuthFailure?.(config);
          if (this.clients.get(server) === client) await this.discardClient(server, client);
        }
        if (this.notConnectedResponse) return this.notConnectedResponse(server);
      }
      throw error;
    }
  }

  getErrors(): McpServerError[] {
    return [...this.errors];
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.entries()].map(async ([server, client]) => {
      try { await withTimeout(client.close(), `MCP server "${server}" close timed out`); }
      catch (error) { this.recordError(server, error); }
    }));
    this.clients.clear();
    this.toolIndex.clear();
  }

  private recordError(server: string, error: unknown, reason = "transport_failed"): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push({ server, message, ...(this.options.statusOnly ? { category: error instanceof OAuthConnectionRequired ? error.failure?.category ?? "authentication" : classifyMcpError(error) } : {}) });
    const result = this.tokenResults.get(server);
    const scope = result?.scope;
    const oauthReason = error instanceof OAuthConnectionRequired ? error.reason : isUnauthorized(error) ? result?.reason : undefined;
    this.logUnavailable(oauthReason ? "info" : reason === "unrecoverable_auth" ? "error" : "warn", message, {
      ...this.logContext, server, reason: oauthReason ?? reason,
      ...(scope ? { scope } : {}),
    });
  }
}

class OAuthConnectionRequired extends Error {
  constructor(readonly reason: NonNullable<McpTokenResult["reason"]>, readonly failure?: McpTokenResult["error"]) { super(failure?.message ?? "OAuth connection required"); }
}
