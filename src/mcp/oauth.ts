import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { raceTimeout, withTimeout } from "./timeout.js";

import {
  discoverOAuthServerInfo,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { resolveAccountLabel } from "./account.js";
import type { McpStaticOAuthClient } from "./loader.js";
import type { McpTokenResult } from "./client-manager.js";
import { classifyMcpError } from "./errors.js";
import { logMcpUnavailable, type McpLogContext, type McpLogPath } from "./logging.js";

export type CredentialScope = { type: "team" } | { type: "personal"; userId: string };
export interface CredentialKey { agentId: string; integration: string; scope: CredentialScope }
export interface ScopedCredentials {
  get<T>(key: CredentialKey): T | undefined;
  save<T>(key: CredentialKey, payload: T): T;
  delete(key: CredentialKey): void;
  resolve<T>(request: { agentId: string; integration: string; requesterUserId?: string; connectUrl: string }): { connected: true; payload: T; scope: CredentialScope } | { connected: false; reason: "not_connected"; connectUrl: string };
}
const TEAM: CredentialScope = { type: "team" };
// Personal grants follow the user across agents, so they live under a fixed agent id.
const SHARED_AGENT = "_shared";

export interface McpServerIdentity { url: string; clientId?: string }
export type ServerIdentityResolver = (agent: string, server: string) => McpServerIdentity | undefined;

/** Normalized URL (lowercase scheme/host, default port and trailing slash dropped) plus the static OAuth client id. */
function identityOf({ url, clientId }: McpServerIdentity): string {
  const parsed = new URL(url);
  const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  return clientId ? `${normalized}#${clientId}` : normalized;
}

export type HostOAuthProviders = () => Record<string, { clientId?: string; clientSecret?: string } | undefined> | undefined;

/** Authorization server host -> host `oauth.providers` key. */
const KNOWN_ISSUER_PROVIDERS: Record<string, string> = { "accounts.google.com": "google", "mcp.hubspot.com": "hubspot" };

function providerNameForIssuer(authorizationServerUrl: string): string | undefined {
  try { return KNOWN_ISSUER_PROVIDERS[new URL(authorizationServerUrl).host.toLowerCase()]; } catch { return undefined; }
}

/** RFC 9728 lookup using the same SDK discovery as `begin()`; true when the resource lists authorization servers. */
export async function hasProtectedResourceAuthServers(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(url, undefined, (input, init) => {
      signal?.throwIfAborted();
      return (signal ? fetch : oauthFetch)(input, { ...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal });
    });
    signal?.throwIfAborted();
    return (metadata.authorization_servers?.length ?? 0) > 0;
  } catch {
    signal?.throwIfAborted();
    // Missing or malformed metadata gives no OAuth evidence.
    return false;
  }
}

export type OAuthState = "connected" | "disconnected" | "needs_reconnect";

export interface OAuthConnection {
  client: OAuthClientInformationFull;
  tokens: OAuthTokens;
  connectedAt: string;
  authorizationServerUrl: string;
  expiresAt?: string;
  state?: OAuthState;
  /** Email or name of the connected account, when the provider reveals it. */
  account?: string;
  /** Normalized url+clientId the grant was issued for; a different current identity invalidates it. */
  identity?: string;
}

export interface AuditActor {
  actorUserId?: string;
  actorEmail?: string;
  impersonatorUserId?: string;
}

interface Tombstone { tombstone: true; deletedAt: string }

export interface PendingOAuthFlow {
  returnTo?: string;
  actor?: AuditActor;
  onComplete?: (targetId: string) => Promise<void>;
  scope: CredentialScope;
  agent: string;
  server: string;
  url: string;
  identity: McpServerIdentity;
  codeVerifier: string;
  createdAt: number;
  client: OAuthClientInformationFull;
}

export class McpOAuthFlowError extends Error {
  constructor(error: unknown, readonly flow: PendingOAuthFlow) {
    super(error instanceof Error ? error.message : "OAuth connection failed", { cause: error });
  }
}

function filePart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expiry(tokens: OAuthTokens): string | undefined {
  return tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined;
}

const oauthFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(input, { ...init, signal });
        if (!response.body) return response;
        // The SDK reads JSON after fetch returns; keep slow bodies inside the deadline.
        const body = await response.arrayBuffer();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("MCP OAuth request timed out")); }, 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
};

export class McpOAuthStore {
  private readonly pending = new Map<string, PendingOAuthFlow>();
  private readonly refreshes = new Map<string, { promise: Promise<McpTokenResult>; controller: AbortController; waiters: number; totalDeadline: boolean }>();
  private readonly accountLookups = new Map<string, Promise<string | undefined>>();

  constructor(private readonly dataDir: string, private readonly redirectUri: string, private readonly credentials?: ScopedCredentials, private readonly identify?: ServerIdentityResolver, private readonly hostProviders?: HostOAuthProviders) {}

  private legacyKey(agent: string, server: string, scope: CredentialScope): CredentialKey {
    return { agentId: agent, integration: `mcp:${server}`, scope };
  }

  private sharedIdentity(agent: string, server: string, identity?: McpServerIdentity): string | undefined {
    try {
      const known = this.identify ? identity ?? this.identify(agent, server) : undefined;
      return known ? identityOf(known) : undefined;
    } catch { return undefined; }
  }

  private key(agent: string, server: string, scope: CredentialScope, identity?: McpServerIdentity): CredentialKey {
    const shared = scope.type === "personal" ? this.sharedIdentity(agent, server, identity) : undefined;
    return shared ? { agentId: SHARED_AGENT, integration: `mcp-url:${shared}`, scope } : this.legacyKey(agent, server, scope);
  }

  async resolve(agent: string, server: string, requesterUserId?: string): Promise<{ connection: OAuthConnection; scope: CredentialScope } | undefined> {
    await this.read(agent, server, TEAM);
    const current = this.sharedIdentity(agent, server);
    const bound = (connection: OAuthConnection) => !current || !connection.identity || connection.identity === current;
    const personal = requesterUserId ? await this.read(agent, server, { type: "personal", userId: requesterUserId }) : undefined;
    if (personal) return { connection: personal, scope: { type: "personal", userId: requesterUserId! } };
    const result = this.credentials?.resolve<OAuthConnection>({ agentId: agent, integration: `mcp:${server}`, connectUrl: `/agents/${encodeURIComponent(agent)}/edit` });
    if (result?.connected && bound(result.payload)) return { connection: result.payload, scope: result.scope };
    const legacy = await this.readLegacy(agent, server);
    return legacy && bound(legacy) ? { connection: legacy, scope: TEAM } : undefined;
  }

  private async readLegacy(agent: string, server: string): Promise<OAuthConnection | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(agent, server), "utf8")) as OAuthConnection; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private file(agent: string, server: string): string {
    return path.join(this.dataDir, "mcp", "oauth", filePart(agent), `${filePart(server)}.json`);
  }

  /** Drops a grant issued for another url/client; stamps the current identity on grants that predate it. */
  private bind(agent: string, server: string, connection: OAuthConnection | undefined, scope: CredentialScope, identity?: McpServerIdentity): OAuthConnection | undefined {
    const current = connection && this.sharedIdentity(agent, server, identity);
    if (!connection || !current) return connection;
    if (connection.identity) return connection.identity === current ? connection : undefined;
    const stamped = { ...connection, identity: current };
    try { this.credentials?.save(this.key(agent, server, scope, identity), stamped); } catch { /* best effort */ }
    return stamped;
  }

  async read(agent: string, server: string, scope: CredentialScope = TEAM, identity?: McpServerIdentity): Promise<OAuthConnection | undefined> {
    return this.bind(agent, server, await this.readStored(agent, server, scope, identity), scope, identity);
  }

  private async readStored(agent: string, server: string, scope: CredentialScope, identity?: McpServerIdentity): Promise<OAuthConnection | undefined> {
    const key = this.key(agent, server, scope, identity);
    const stored = this.credentials?.get<OAuthConnection | Tombstone>(key);
    if (stored && "tombstone" in stored) return undefined;
    if (scope.type === "personal") {
      if (stored || !this.credentials || key.agentId !== SHARED_AGENT) return stored;
      const legacyKey = this.legacyKey(agent, server, scope);
      const legacyPersonal = this.credentials.get<OAuthConnection>(legacyKey);
      if (!legacyPersonal) return undefined;
      try {
        this.credentials.save(key, legacyPersonal);
      } catch { return legacyPersonal; }
      this.credentials.delete(legacyKey);
      return legacyPersonal;
    }
    if (stored) return stored;
    const legacy = await this.readLegacy(agent, server);
    if (!legacy || !this.credentials) return legacy;
    try {
      this.credentials.save(this.key(agent, server, TEAM), legacy);
    } catch { return legacy; }
    await fs.rm(this.file(agent, server), { force: true });
    return legacy;
  }

  async write(agent: string, server: string, connection: OAuthConnection, scope: CredentialScope = TEAM, identity?: McpServerIdentity): Promise<void> {
    if (!this.credentials) throw new Error("The host scoped credential store is unavailable");
    this.credentials.save(this.key(agent, server, scope, identity), connection);
    if (scope.type === "team") await fs.rm(this.file(agent, server), { force: true });
  }

  async delete(agent: string, server: string, scope: CredentialScope = TEAM): Promise<void> {
    const key = this.key(agent, server, scope);
    // Tombstone keeps other agents' legacy personal rows from being promoted back after a disconnect.
    if (scope.type === "personal" && key.agentId === SHARED_AGENT) this.credentials?.save<Tombstone>(key, { tombstone: true, deletedAt: new Date().toISOString() });
    else this.credentials?.delete(key);
    if (scope.type === "personal") this.credentials?.delete(this.legacyKey(agent, server, scope));
    if (scope.type === "team") await fs.rm(this.file(agent, server), { force: true });
  }

  async disconnect(agent: string, server: string, scope: CredentialScope = TEAM): Promise<boolean> {
    const connection = await this.read(agent, server, scope);
    await this.delete(agent, server, scope);
    if (!connection) return false;
    void this.revokeConnection(connection);
    return true;
  }

  private async revokeConnection(connection: OAuthConnection): Promise<void> {
    try {
      const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl, { fetchFn: oauthFetch });
      const endpoint = (metadata as Record<string, unknown> | undefined)?.revocation_endpoint;
      if (typeof endpoint !== "string") return;
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ token: connection.tokens.refresh_token ?? connection.tokens.access_token, client_id: connection.client.client_id }),
      });
    } catch {
      // Revocation is best-effort; local token deletion still disconnects the agent.
    }
  }

  async markNeedsReconnect(agent: string, server: string, scope: CredentialScope = TEAM): Promise<void> {
    const connection = await this.read(agent, server, scope);
    if (connection) await this.write(agent, server, { ...connection, state: "needs_reconnect" }, scope);
  }

  async begin(agent: string, server: string, url: string, staticClient?: McpStaticOAuthClient, scope: CredentialScope = TEAM, onComplete?: (targetId: string) => Promise<void>, actor?: AuditActor, returnTo?: string): Promise<{ state: string; authorizationUrl: string }> {
    if (!this.credentials) throw new Error("The host scoped credential store is unavailable");
    const info = await discoverOAuthServerInfo(url, { fetchFn: oauthFetch });
    const dynamic = Boolean(info.authorizationServerMetadata?.registration_endpoint);
    const providerName = providerNameForIssuer(info.authorizationServerUrl);
    const provider = !staticClient && !dynamic && providerName ? this.hostProviders?.()?.[providerName] : undefined;
    const hostClient = provider?.clientId ? { clientId: provider.clientId, clientSecret: provider.clientSecret } : undefined;
    if (!staticClient && !dynamic && !hostClient) {
      throw new Error(`OAuth server does not support dynamic client registration; set oauth.clientId in mcp.json or configure oauth.providers.${providerName ?? "<provider>"} in yoplai.json`);
    }
    const preRegistered = staticClient ?? hostClient;
    const identity = { url, clientId: staticClient?.clientId };
    const existing = await this.read(agent, server, scope, identity);
    const client: OAuthClientInformationFull = preRegistered
      ? { client_id: preRegistered.clientId, ...(preRegistered.clientSecret ? { client_secret: preRegistered.clientSecret } : {}), redirect_uris: [this.redirectUri] }
      : existing?.client ?? await registerClient(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        fetchFn: oauthFetch,
        clientMetadata: { client_name: "Yoplai MCP", redirect_uris: [this.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      });
    // MCP scope selection: without a configured list, request every scope the resource advertises (some servers reject an empty scope).
    const scopes = staticClient?.scopes?.length ? staticClient.scopes : info.resourceMetadata?.scopes_supported ?? [];
    const state = crypto.randomBytes(32).toString("base64url");
    const auth = await startAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: client,
      redirectUrl: this.redirectUri,
      state,
      resource: new URL(url),
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    });
    if (preRegistered) {
      // Pre-registered clients (e.g. Google) only issue refresh tokens for offline access with explicit consent.
      auth.authorizationUrl.searchParams.set("access_type", "offline");
      auth.authorizationUrl.searchParams.set("prompt", "consent");
    }
    this.pending.set(state, { returnTo, actor, onComplete, scope, agent, server, url, identity, codeVerifier: auth.codeVerifier, createdAt: Date.now(), client });
    return { state, authorizationUrl: auth.authorizationUrl.toString() };
  }

  cancel(state: string): PendingOAuthFlow | undefined {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    return pending && Date.now() - pending.createdAt <= 10 * 60 * 1000 ? pending : undefined;
  }

  async finish(state: string, code: string, onConnected?: (flow: PendingOAuthFlow) => void): Promise<PendingOAuthFlow> {
    const pending = this.cancel(state);
    if (!pending) throw new Error("OAuth state is invalid or expired");
    try {
      const info = await discoverOAuthServerInfo(pending.url, { fetchFn: oauthFetch });
      const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata: info.authorizationServerMetadata, clientInformation: pending.client, fetchFn: oauthFetch, authorizationCode: code, codeVerifier: pending.codeVerifier, redirectUri: this.redirectUri, resource: new URL(pending.url) });
      const account = await resolveAccountLabel({ serverUrl: pending.url, authorizationServerUrl: info.authorizationServerUrl, tokens });
      await this.write(pending.agent, pending.server, { client: pending.client, tokens, connectedAt: new Date().toISOString(), authorizationServerUrl: info.authorizationServerUrl, expiresAt: expiry(tokens), state: "connected", identity: identityOf(pending.identity), ...(account ? { account } : {}) }, pending.scope, pending.identity);
      onConnected?.(pending);
      await pending.onComplete?.(pending.server);
      return pending;
    } catch (error) { throw new McpOAuthFlowError(error, pending); }
  }

  /** Resolves and persists the account label of a connection that predates it; one attempt per credential per process, waiting at most `waitMs`. */
  backfillAccount(agent: string, server: string, url: string, scope: CredentialScope, connection: OAuthConnection, waitMs = 2_000, logContext: Omit<McpLogContext, "agentId"> = { path: "status" }): Promise<string | undefined> {
    if (connection.account || connection.state === "needs_reconnect") return Promise.resolve(connection.account);
    const key = JSON.stringify([this.key(agent, server, scope), connection.connectedAt]);
    const lookup = this.accountLookups.get(key) ?? this.startAccountLookup(key, agent, server, url, scope, connection, logContext);
    // Slow lookups keep running and persist; this request just returns without the label.
    return raceTimeout(lookup, waitMs);
  }

  private startAccountLookup(key: string, agent: string, server: string, url: string, scope: CredentialScope, connection: OAuthConnection, logContext: Omit<McpLogContext, "agentId">): Promise<string | undefined> {
    const lookup = (async () => {
      const token = await this.accessToken(agent, server, 60_000, logContext.userId, scope, logContext.path);
      const latest = await this.read(agent, server, scope);
      if (!token || !latest || latest.connectedAt !== connection.connectedAt) return undefined;
      const account = await resolveAccountLabel({ serverUrl: url, authorizationServerUrl: latest.authorizationServerUrl, tokens: { ...latest.tokens, access_token: token } });
      const current = account ? await this.read(agent, server, scope) : undefined;
      // Skip while a refresh is in flight; refresh keeps account-only changes, so a later status call retries.
      if (account && current?.connectedAt === connection.connectedAt && current.state !== "needs_reconnect" && !this.refreshes.has(JSON.stringify(this.key(agent, server, scope)))) await this.write(agent, server, { ...current, account }, scope);
      return account;
    })().catch(() => undefined);
    this.accountLookups.set(key, lookup);
    return lookup;
  }

  private async resolveScoped(agent: string, server: string, requesterUserId?: string, exactScope?: CredentialScope): Promise<{ connection: OAuthConnection; scope: CredentialScope } | undefined> {
    if (!exactScope) return this.resolve(agent, server, requesterUserId);
    const exact = await this.read(agent, server, exactScope);
    return exact ? { connection: exact, scope: exactScope } : undefined;
  }

  private async dedupedRefresh(agent: string, server: string, connection: OAuthConnection, scope: CredentialScope, requesterUserId?: string, logPath: McpLogPath = "tools", statusOnly = false, statusSignal?: AbortSignal): Promise<McpTokenResult> {
    if (statusOnly) return this.refreshConnection(agent, server, connection, scope, requesterUserId, logPath, statusOnly, statusSignal);
    statusSignal?.throwIfAborted();
    const key = JSON.stringify(this.key(agent, server, scope));
    let refresh = this.refreshes.get(key);
    if (!refresh) {
      const controller = new AbortController();
      const promise = this.refreshConnection(agent, server, connection, scope, requesterUserId, logPath, false, controller.signal, Boolean(statusSignal));
      const pending = { promise, controller, waiters: 0, totalDeadline: Boolean(statusSignal) };
      refresh = pending;
      this.refreshes.set(key, pending);
      void promise.finally(() => {
        controller.abort();
        if (this.refreshes.get(key) === pending) this.refreshes.delete(key);
      }).catch(() => {});
    }
    refresh.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      if (!statusSignal) {
        if (!refresh.totalDeadline) return await refresh.promise;
        return await withTimeout(refresh.promise, 10_000, "OAuth refresh timed out").catch(() => ({ reason: "refresh_failed" as const, scope: scope.type }));
      }
      return await Promise.race([
        refresh.promise,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(statusSignal.reason);
          statusSignal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) statusSignal?.removeEventListener("abort", onAbort);
      if (--refresh.waiters === 0 && this.refreshes.get(key) === refresh) {
        this.refreshes.delete(key);
        refresh.controller.abort(statusSignal?.reason);
      }
    }
  }

  async accessToken(agent: string, server: string, skewMs = 60_000, requesterUserId?: string, exactScope?: CredentialScope, logPath: McpLogPath = "tools"): Promise<string | undefined> {
    return (await this.accessTokenResult(agent, server, skewMs, requesterUserId, exactScope, logPath)).token;
  }

  async accessTokenResult(agent: string, server: string, skewMs = 60_000, requesterUserId?: string, exactScope?: CredentialScope, logPath: McpLogPath = "tools", statusOnly = false, statusSignal?: AbortSignal): Promise<McpTokenResult> {
    const resolved = await this.resolveScoped(agent, server, requesterUserId, exactScope);
    if (!resolved) return { reason: "not_connected" };
    const { connection, scope } = resolved;
    if (connection.state === "needs_reconnect") return { reason: "needs_reconnect", scope: scope.type };
    if (!connection.expiresAt || Date.parse(connection.expiresAt) - Date.now() > skewMs) return { token: connection.tokens.access_token, scope: scope.type };
    return this.dedupedRefresh(agent, server, connection, scope, requesterUserId, logPath, statusOnly, statusSignal);
  }

  async refreshAccessToken(agent: string, server: string, requesterUserId?: string, exactScope?: CredentialScope, logPath: McpLogPath = "tools"): Promise<string | undefined> {
    return (await this.refreshAccessTokenResult(agent, server, requesterUserId, exactScope, logPath)).token;
  }

  async refreshAccessTokenResult(agent: string, server: string, requesterUserId?: string, exactScope?: CredentialScope, logPath: McpLogPath = "tools", statusOnly = false, statusSignal?: AbortSignal): Promise<McpTokenResult> {
    const resolved = await this.resolveScoped(agent, server, requesterUserId, exactScope);
    return resolved ? this.dedupedRefresh(agent, server, resolved.connection, resolved.scope, requesterUserId, logPath, statusOnly, statusSignal) : { reason: "not_connected" };
  }

  private async refreshConnection(
    agent: string,
    server: string,
    connection: OAuthConnection,
    scope: CredentialScope,
    requesterUserId?: string,
    logPath: McpLogPath = "tools",
    statusOnly = false,
    statusSignal?: AbortSignal,
    totalDeadline = false,
  ): Promise<McpTokenResult> {
    const expired = (): McpTokenResult => ({ reason: "refresh_failed", scope: scope.type, error: { category: "timeout", message: "MCP server status timed out" } });
    // An account label written meanwhile is not a competing grant: compare without it and keep it on save.
    const comparable = (value?: OAuthConnection) => value ? JSON.stringify({ ...value, account: undefined }) : undefined;
    const unchanged = async () => { const latest = await this.read(agent, server, scope); return latest && comparable(latest) === comparable(connection) ? latest : undefined; };
    const reconnect = async () => {
      const latest = await unchanged();
      if (latest && !statusSignal?.aborted) await this.write(agent, server, { ...latest, state: "needs_reconnect" }, scope);
    };
    if (!connection.tokens.refresh_token) {
      if (statusSignal?.aborted) return expired();
      await reconnect();
      return { reason: "needs_reconnect", scope: scope.type };
    }
    try {
      const fetchFn: typeof fetch = (input, init) => {
        statusSignal?.throwIfAborted();
        const signal = statusSignal && init?.signal ? AbortSignal.any([statusSignal, init.signal]) : statusSignal ?? init?.signal;
        return fetch(input, { ...init, signal });
      };
      const refreshing = (async () => {
        const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl, { fetchFn });
        statusSignal?.throwIfAborted();
        return refreshAuthorization(connection.authorizationServerUrl, { metadata, clientInformation: connection.client, refreshToken: connection.tokens.refresh_token!, fetchFn });
      })();
      const tokens = await (totalDeadline ? refreshing : withTimeout(refreshing, 10_000, "OAuth refresh timed out"));
      const latest = await unchanged();
      if (statusSignal?.aborted) return expired();
      if (!latest) return { reason: "not_connected", scope: scope.type };
      await this.write(agent, server, { ...connection, ...(latest.account ? { account: latest.account } : {}), tokens, expiresAt: expiry(tokens), state: "connected" }, scope);
      return { token: tokens.access_token, scope: scope.type };
    } catch (error) {
      logMcpUnavailable("error", error instanceof Error ? error.message : String(error), {
        agentId: agent, userId: requesterUserId, path: logPath, server, reason: "refresh_failed", scope: scope.type,
      });
      if (statusSignal?.aborted) return expired();
      const category = classifyMcpError(error);
      if (!statusOnly || category === "authentication") await reconnect();
      return { reason: "refresh_failed", scope: scope.type, ...(statusOnly ? { error: { category, message: error instanceof Error ? error.message : String(error) } } : {}) };
    }
  }
}
