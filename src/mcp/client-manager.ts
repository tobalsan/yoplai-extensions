import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpResourceContent, McpToolUi, McpToolVisibility } from "../tool-extension.js";

import { classifyMcpError, isUnauthorized, type McpErrorCategory } from "./errors.js";
import type { ServerIcon } from "./icon.js";
import type { McpServerConfig } from "./loader.js";
import { logMcpUnavailable, type McpLogContext, type McpLogEvent, type McpLogLevel } from "./logging.js";
import { withTimeout as withDeadline } from "./timeout.js";

const withTimeout = <T>(task: Promise<T>, message: string): Promise<T> => withDeadline(task, 10_000, message);

export interface McpToolDefinition {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  visibility: McpToolVisibility;
  ui?: McpToolUi;
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
  listTools(options?: { signal?: AbortSignal }): Promise<McpToolDefinition[]>;
  readResource(uri: string, options?: { signal?: AbortSignal }): Promise<{ contents: McpResourceContent[] }>;
  callTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  getServerIcon?(): string | undefined;
  getServerIcons?(): ServerIcon[] | undefined;
  getServerInfo?(): McpServerLabel;
  getInstructions?(): string | undefined;
}

export type McpClientFactory = (server: McpServerConfig, accessToken?: string, options?: { signal?: AbortSignal }) => Promise<McpClientHandle>;
export interface McpTokenResult {
  error?: { category: McpErrorCategory; message: string };
  token?: string;
  reason?: "not_connected" | "needs_reconnect" | "refresh_failed";
  scope?: "personal" | "team";
}
export type McpTokenProvider = (server: McpServerConfig) => Promise<string | McpTokenResult | undefined>;
type McpAuthRecovery = (server: McpServerConfig) => Promise<boolean | McpTokenResult>;
export type McpNotConnectedResponse = (server: string) => unknown;

export interface McpClientManagerOptions {
  signal?: AbortSignal;
  throwOnError?: boolean;
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
    private readonly transport: Transport
  ) {}

  static async connect(server: McpServerConfig, accessToken?: string, statusOnly = false, options?: { signal?: AbortSignal; transportFactory?: (server: McpServerConfig, accessToken?: string) => Transport }): Promise<SdkMcpClientHandle> {
    const client = new Client({ name: "yoplai-mcp", version: "0.1.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
    const transport = (options?.transportFactory ?? createTransport)(server, accessToken);
    try {
      options?.signal?.throwIfAborted();
      const pending = client.connect(transport, { signal: options?.signal });
      await abortable(options?.signal ? pending : withTimeout(pending, `MCP server "${server.name}" connection timed out`), options?.signal);
    } catch (error) {
      if (statusOnly || options?.signal?.aborted) {
        void withTimeout(transport.close(), `MCP server "${server.name}" close timed out`).catch(() => {});
        throw error;
      }
      try { await withTimeout(transport.close(), `MCP server "${server.name}" close timed out`); }
      catch { /* The original connection error is more useful. */ }
      throw error;
    }
    return new SdkMcpClientHandle(server.name, client, transport);
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<McpToolDefinition[]> {
    const result = await this.client.listTools(undefined, options);
    return result.tools.map((tool) => ({
      server: this.serverName,
      name: tool.name,
      description: tool.description ?? `MCP tool ${tool.name} from ${this.serverName}`,
      inputSchema: tool.inputSchema,
      ...toolUiMetadata(tool._meta),
    }));
  }

  async callTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    return await this.client.callTool({
      name,
      arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
    }, undefined, { signal: options?.signal });
  }

  async readResource(uri: string, options?: { signal?: AbortSignal }): Promise<{ contents: McpResourceContent[] }> {
    return await this.client.readResource({ uri }, options);
  }

  getServerIcon(): string | undefined {
    return this.client.getServerVersion()?.icons?.[0]?.src;
  }

  getServerIcons(): ServerIcon[] | undefined {
    return this.client.getServerVersion()?.icons;
  }

  getServerInfo(): McpServerLabel {
    return labelFromServerInfo(this.client.getServerVersion());
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions()?.trim() || undefined;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function toolUiMetadata(meta?: Record<string, unknown>): Pick<McpToolDefinition, "_meta" | "visibility" | "ui"> {
  const ui = meta?.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui) ? meta.ui as Record<string, unknown> : undefined;
  const rawVisibility = ui?.visibility;
  let visibility: McpToolVisibility = ["model", "app"];
  if (rawVisibility !== undefined) {
    visibility = Array.isArray(rawVisibility) && rawVisibility.every((item) => item === "model" || item === "app")
      ? rawVisibility : ["model"];
  }
  const resourceUri = ui?.resourceUri ?? meta?.["ui/resourceUri"];
  let view: McpToolUi | undefined;
  if (typeof resourceUri === "string") {
    try {
      if (resourceUri.startsWith("ui://") && new URL(resourceUri).protocol === "ui:") view = { resourceUri, visibility };
    } catch { /* Invalid URIs have no view. */ }
  }
  return { ...(meta ? { _meta: meta } : {}), visibility, ...(view ? { ui: view } : {}) };
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
  private readonly logContext: McpLogContext;
  private readonly logUnavailable: typeof logMcpUnavailable;
  private readonly onConnected?: (server: string) => void;
  private readonly tokenResults = new Map<string, McpTokenResult>();
  private readonly clients = new Map<string, McpClientHandle>();
  private readonly toolIndex = new Map<string, { server: string; tool: string }>();
  private readonly errors: McpServerError[] = [];
  private readonly recoveries = new Map<string, Promise<boolean>>();
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
    this.clientFactory = options.clientFactory ?? ((server, token, request) => SdkMcpClientHandle.connect(server, token, options.statusOnly, request));
    this.tokenProvider = options.tokenProvider;
    this.onAuthFailure = options.onAuthFailure;
    this.requiresOAuth = options.requiresOAuth;
    this.notConnectedResponse = options.notConnectedResponse;
    this.onUnrecoverableAuthFailure = options.onUnrecoverableAuthFailure;
  }

  async connect(): Promise<void> {
    this.options.signal?.throwIfAborted();
    if (this.connecting) return this.connecting;
    this.connecting = Promise.all(
      this.servers.filter((server) => !this.clients.has(server.name)).map(async (server) => {
        try {
          await this.connectServer(server);
        } catch (error) {
          this.options.signal?.throwIfAborted();
          if (!(error instanceof OAuthConnectionRequired) && (this.options.statusOnly ? classifyMcpError(error) === "authentication" : isUnauthorized(error))) {
            if (this.options.statusOnly) error = await this.statusAuthFailure(server, error);
            else if (await this.recover(server)) return;
          }
          if (this.options.throwOnError) throw error;
          this.recordError(server.name, error);
        }
      })
    ).then(() => undefined);
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private async connectServer(server: McpServerConfig, signal = this.options.signal): Promise<void> {
    signal?.throwIfAborted();
    const provided = server.type === "http" && !server.headers && this.tokenProvider
      ? await abortable(this.tokenProvider(server), signal)
      : undefined;
    signal?.throwIfAborted();
    const result = typeof provided === "string" ? { token: provided } : provided;
    this.tokenResults.set(server.name, result ?? {});
    const accessToken = result?.token;
    if (server.type === "http" && !server.headers && this.tokenProvider && await abortable(Promise.resolve(this.requiresOAuth?.(server)), signal) && !accessToken) {
      throw new OAuthConnectionRequired(result?.reason ?? "not_connected", result?.error);
    }
    signal?.throwIfAborted();
    const pending = this.clientFactory(server, accessToken, { signal });
    let abandoned = false;
    void pending.then((client) => { if (abandoned || signal?.aborted) return client.close(); }).catch(() => {});
    const client = await abortable(this.options.throwOnError ? pending : withTimeout(pending, `MCP server "${server.name}" connection timed out`), signal).catch((error: unknown) => {
      abandoned = true;
      throw error;
    });
    signal?.throwIfAborted();
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

  private async recover(server: McpServerConfig, signal = this.options.signal): Promise<boolean> {
    const activeRecovery = this.recoveries.get(server.name);
    if (activeRecovery) return activeRecovery;
    signal?.throwIfAborted();
    const recovery = this.recoverServer(server, signal);
    this.recoveries.set(server.name, recovery);
    try {
      return await recovery;
    } finally {
      this.recoveries.delete(server.name);
    }
  }

  private async recoverServer(server: McpServerConfig, signal?: AbortSignal): Promise<boolean> {
    if (!this.onAuthFailure) return false;
    signal?.throwIfAborted();
    const recovery = await abortable(this.onAuthFailure(server), signal);
    signal?.throwIfAborted();
    if (typeof recovery !== "boolean") this.tokenResults.set(server.name, recovery);
    if (typeof recovery === "boolean" ? !recovery : !recovery.token) {
      if (this.options.throwOnError) throw new OAuthConnectionRequired(typeof recovery === "boolean" ? "needs_reconnect" : recovery.reason ?? "needs_reconnect", typeof recovery === "boolean" ? undefined : recovery.error);
      return false;
    }
    const client = this.clients.get(server.name);
    this.clients.delete(server.name);
    if (client) {
      try {
        await abortable(withTimeout(client.close(), `MCP server "${server.name}" close timed out`), signal);
      } catch (error) {
        this.recordError(server.name, error);
      }
    }
    try {
      signal?.throwIfAborted();
      await this.connectServer(server, signal);
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (isUnauthorized(error)) await abortable(Promise.resolve(this.onUnrecoverableAuthFailure?.(server)), signal);
      signal?.throwIfAborted();
      if (this.options.throwOnError) throw isUnauthorized(error) ? new OAuthConnectionRequired("needs_reconnect") : error;
      this.recordError(server.name, error, isUnauthorized(error) ? "unrecoverable_auth" : "transport_failed");
      return false;
    }
  }

  private async discardClient(server: string, client: McpClientHandle): Promise<void> {
    if (this.clients.get(server) === client) this.clients.delete(server);
    if (this.options.throwOnError) { void client.close().catch(() => {}); return; }
    try {
      await withTimeout(client.close(), `MCP server "${server}" close timed out`);
    } catch (error) {
      this.recordError(server, error);
    }
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<McpToolDefinition[]> {
    const signal = this.requestSignal(options?.signal);
    signal?.throwIfAborted();
    const list = (client: McpClientHandle, server: string) => {
      signal?.throwIfAborted();
      const pending = client.listTools({ signal });
      return abortable(this.options.throwOnError ? pending : withTimeout(pending, `MCP server "${server}" tool listing timed out`), signal);
    };
    const groups = await Promise.all(
      [...this.clients.entries()].map(async ([server, client]) => {
        try {
          return await list(client, server);
        } catch (error) {
          signal?.throwIfAborted();
          const config = this.servers.find((item) => item.name === server);
          if (config && this.options.statusOnly && classifyMcpError(error) === "authentication") error = await this.statusAuthFailure(config, error);
          if (config && isUnauthorized(error) && !this.options.statusOnly && await this.recover(config, signal)) {
            const refreshed = this.clients.get(server);
            if (refreshed) {
              try {
                return await list(refreshed, server);
              } catch (retryError) {
                signal?.throwIfAborted();
                if (isUnauthorized(retryError)) await abortable(Promise.resolve(this.onUnrecoverableAuthFailure?.(config)), signal);
                signal?.throwIfAborted();
                this.recordError(server, retryError, isUnauthorized(retryError) ? "unrecoverable_auth" : "transport_failed");
                await this.discardClient(server, refreshed);
                if (this.options.throwOnError) throw isUnauthorized(retryError) ? new OAuthConnectionRequired("needs_reconnect") : retryError;
                return [];
              }
            }
          }
          if (this.options.throwOnError) throw error;
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

  private requestSignal(signal?: AbortSignal): AbortSignal | undefined {
    return this.options.signal && signal && this.options.signal !== signal
      ? AbortSignal.any([this.options.signal, signal]) : signal ?? this.options.signal;
  }

  hasClient(server: string): boolean {
    return this.clients.has(server);
  }

  getServerIcon(server: string): string | undefined {
    return this.clients.get(server)?.getServerIcon?.();
  }

  getServerIcons(server: string): ServerIcon[] | undefined {
    const client = this.clients.get(server);
    const icons = client?.getServerIcons?.();
    if (icons !== undefined) return icons;
    const src = client?.getServerIcon?.();
    return src ? [{ src }] : undefined;
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
    const signal = this.requestSignal(options?.signal);
    return this.request(server, (client) => client.callTool(tool, args, { signal }), signal,
      !this.options.throwOnError && this.notConnectedResponse ? () => this.notConnectedResponse!(server) : undefined);
  }

  async readResource(server: string, uri: string, options?: { signal?: AbortSignal }): Promise<{ contents: McpResourceContent[] }> {
    const signal = this.requestSignal(options?.signal);
    return this.request(server, (client) => client.readResource(uri, { signal }), signal);
  }

  private async request<T>(server: string, run: (client: McpClientHandle) => Promise<T>, signal?: AbortSignal, notConnected?: () => T): Promise<T> {
    signal?.throwIfAborted();
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server "${server}" is not connected`);
    try {
      return await abortable(run(client), signal);
    } catch (error) {
      signal?.throwIfAborted();
      const config = this.servers.find((item) => item.name === server);
      if (config && isUnauthorized(error)) {
        if (await this.recover(config, signal)) {
          signal?.throwIfAborted();
          const refreshed = this.clients.get(server);
          if (refreshed) {
            try {
              return await abortable(run(refreshed), signal);
            } catch (retryError) {
              signal?.throwIfAborted();
              if (isUnauthorized(retryError)) {
                await abortable(Promise.resolve(this.onUnrecoverableAuthFailure?.(config)), signal);
                signal?.throwIfAborted();
                this.recordError(server, retryError, "unrecoverable_auth");
                await this.discardClient(server, refreshed);
                if (this.options.throwOnError) throw new OAuthConnectionRequired("needs_reconnect");
                if (notConnected) return notConnected();
              }
              throw retryError;
            }
          }
        }
        signal?.throwIfAborted();
        if (notConnected) return notConnected();
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

export class OAuthConnectionRequired extends Error {
  constructor(readonly reason: NonNullable<McpTokenResult["reason"]>, readonly failure?: McpTokenResult["error"]) { super(failure?.message ?? "OAuth connection required"); }
}

async function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
