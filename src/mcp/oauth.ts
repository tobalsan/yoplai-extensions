import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  discoverOAuthServerInfo,
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpStaticOAuthClient } from "./loader.js";

export type CredentialScope = { type: "team" } | { type: "personal"; userId: string };
export interface CredentialKey { agentId: string; integration: string; scope: CredentialScope }
export interface ScopedCredentials {
  get<T>(key: CredentialKey): T | undefined;
  save<T>(key: CredentialKey, payload: T): T;
  delete(key: CredentialKey): void;
  resolve<T>(request: { agentId: string; integration: string; requesterUserId?: string; connectUrl: string }): { connected: true; payload: T; scope: CredentialScope } | { connected: false; reason: "not_connected"; connectUrl: string };
}
const TEAM: CredentialScope = { type: "team" };

export type OAuthState = "connected" | "disconnected" | "needs_reconnect";

export interface OAuthConnection {
  client: OAuthClientInformationFull;
  tokens: OAuthTokens;
  connectedAt: string;
  authorizationServerUrl: string;
  expiresAt?: string;
  state?: OAuthState;
}

export interface PendingOAuthFlow {
  scope: CredentialScope;
  agent: string;
  server: string;
  url: string;
  codeVerifier: string;
  createdAt: number;
  client: OAuthClientInformationFull;
}

function filePart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expiry(tokens: OAuthTokens): string | undefined {
  return tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined;
}

export class McpOAuthStore {
  private readonly pending = new Map<string, PendingOAuthFlow>();
  private readonly refreshes = new Map<string, Promise<string | undefined>>();

  constructor(private readonly dataDir: string, private readonly redirectUri: string, private readonly credentials?: ScopedCredentials) {}

  private key(agent: string, server: string, scope: CredentialScope): CredentialKey {
    return { agentId: agent, integration: `mcp:${server}`, scope };
  }

  async resolve(agent: string, server: string, requesterUserId?: string): Promise<{ connection: OAuthConnection; scope: CredentialScope } | undefined> {
    await this.read(agent, server, TEAM);
    const personal = requesterUserId ? this.credentials?.get<OAuthConnection>(this.key(agent, server, { type: "personal", userId: requesterUserId })) : undefined;
    if (personal) return { connection: personal, scope: { type: "personal", userId: requesterUserId! } };
    const result = this.credentials?.resolve<OAuthConnection>({ agentId: agent, integration: `mcp:${server}`, requesterUserId, connectUrl: `/agents/${encodeURIComponent(agent)}/extensions/mcp?scope=personal` });
    if (result?.connected) return { connection: result.payload, scope: result.scope };
    const legacy = await this.readLegacy(agent, server);
    return legacy ? { connection: legacy, scope: TEAM } : undefined;
  }

  private async readLegacy(agent: string, server: string): Promise<OAuthConnection | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(agent, server), "utf8")) as OAuthConnection; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private file(agent: string, server: string): string {
    return path.join(this.dataDir, "mcp", "oauth", filePart(agent), `${filePart(server)}.json`);
  }

  async read(agent: string, server: string, scope: CredentialScope = TEAM): Promise<OAuthConnection | undefined> {
    const stored = this.credentials?.get<OAuthConnection>(this.key(agent, server, scope));
    if (stored || scope.type === "personal") return stored;
    const legacy = await this.readLegacy(agent, server);
    if (!legacy || !this.credentials) return legacy;
    try {
      this.credentials.save(this.key(agent, server, TEAM), legacy);
    } catch { return legacy; }
    await fs.rm(this.file(agent, server), { force: true });
    return legacy;
  }

  async write(agent: string, server: string, connection: OAuthConnection, scope: CredentialScope = TEAM): Promise<void> {
    if (!this.credentials) throw new Error("The host scoped credential store is unavailable");
    this.credentials.save(this.key(agent, server, scope), connection);
    if (scope.type === "team") await fs.rm(this.file(agent, server), { force: true });
  }

  async delete(agent: string, server: string, scope: CredentialScope = TEAM): Promise<void> {
    this.credentials?.delete(this.key(agent, server, scope));
    if (scope.type === "team") await fs.rm(this.file(agent, server), { force: true });
  }

  async revoke(agent: string, server: string, scope: CredentialScope = TEAM): Promise<void> {
    const connection = await this.read(agent, server, scope);
    if (!connection) return;
    try {
      const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl);
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

  async begin(agent: string, server: string, url: string, staticClient?: McpStaticOAuthClient, scope: CredentialScope = TEAM): Promise<{ state: string; authorizationUrl: string }> {
    if (!this.credentials) throw new Error("The host scoped credential store is unavailable");
    const info = await discoverOAuthServerInfo(url);
    if (!staticClient && !info.authorizationServerMetadata?.registration_endpoint) {
      throw new Error("OAuth server does not support dynamic client registration; set oauth.clientId in mcp.json");
    }
    const existing = await this.read(agent, server, scope);
    const client: OAuthClientInformationFull = staticClient
      ? { client_id: staticClient.clientId, ...(staticClient.clientSecret ? { client_secret: staticClient.clientSecret } : {}), redirect_uris: [this.redirectUri] }
      : existing?.client ?? await registerClient(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientMetadata: { client_name: "Yoplai MCP", redirect_uris: [this.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      });
    const state = crypto.randomBytes(32).toString("base64url");
    const auth = await startAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: client,
      redirectUrl: this.redirectUri,
      state,
      resource: new URL(url),
      ...(staticClient?.scopes?.length ? { scope: staticClient.scopes.join(" ") } : {}),
    });
    if (staticClient) {
      // Pre-registered clients (e.g. Google) only issue refresh tokens for offline access with explicit consent.
      auth.authorizationUrl.searchParams.set("access_type", "offline");
      auth.authorizationUrl.searchParams.set("prompt", "consent");
    }
    this.pending.set(state, { scope, agent, server, url, codeVerifier: auth.codeVerifier, createdAt: Date.now(), client });
    return { state, authorizationUrl: auth.authorizationUrl.toString() };
  }

  async finish(state: string, code: string): Promise<{ agent: string; server: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) throw new Error("OAuth state is invalid or expired");
    const info = await discoverOAuthServerInfo(pending.url);
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata: info.authorizationServerMetadata, clientInformation: pending.client, authorizationCode: code, codeVerifier: pending.codeVerifier, redirectUri: this.redirectUri, resource: new URL(pending.url) });
    await this.write(pending.agent, pending.server, { client: pending.client, tokens, connectedAt: new Date().toISOString(), authorizationServerUrl: info.authorizationServerUrl, expiresAt: expiry(tokens), state: "connected" }, pending.scope);
    return pending;
  }

  async accessToken(agent: string, server: string, skewMs = 60_000, requesterUserId?: string, exactScope?: CredentialScope): Promise<string | undefined> {
    const exact = exactScope ? await this.read(agent, server, exactScope) : undefined;
    const resolved = exactScope ? (exact ? { connection: exact, scope: exactScope } : undefined) : await this.resolve(agent, server, requesterUserId);
    const connection = resolved?.connection;
    if (!connection) return undefined;
    if (connection.state === "needs_reconnect") return undefined;
    if (!connection.expiresAt || Date.parse(connection.expiresAt) - Date.now() > skewMs) return connection.tokens.access_token;
    const scope = resolved!.scope;
    const key = JSON.stringify(this.key(agent, server, scope));
    const activeRefresh = this.refreshes.get(key);
    if (activeRefresh) return activeRefresh;

    const refresh = this.refreshConnection(agent, server, connection, scope);
    this.refreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshes.delete(key);
    }
  }

  async refreshAccessToken(agent: string, server: string, requesterUserId?: string, exactScope?: CredentialScope): Promise<string | undefined> {
    const exact = exactScope ? await this.read(agent, server, exactScope) : undefined;
    const resolved = exactScope ? (exact ? { connection: exact, scope: exactScope } : undefined) : await this.resolve(agent, server, requesterUserId);
    const connection = resolved?.connection;
    if (!connection) return undefined;
    const scope = resolved!.scope;
    const key = JSON.stringify(this.key(agent, server, scope));
    const activeRefresh = this.refreshes.get(key);
    if (activeRefresh) return activeRefresh;

    const refresh = this.refreshConnection(agent, server, connection, scope);
    this.refreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshes.delete(key);
    }
  }

  private async refreshConnection(
    agent: string,
    server: string,
    connection: OAuthConnection,
    scope: CredentialScope,
  ): Promise<string | undefined> {
    const unchanged = async () => JSON.stringify(await this.read(agent, server, scope)) === JSON.stringify(connection);
    if (!connection.tokens.refresh_token) {
      if (await unchanged()) await this.markNeedsReconnect(agent, server, scope);
      return undefined;
    }
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const tokens = await Promise.race([
        (async () => {
          const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl);
          return refreshAuthorization(connection.authorizationServerUrl, { metadata, clientInformation: connection.client, refreshToken: connection.tokens.refresh_token! });
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("OAuth refresh timed out")), 10_000); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (!await unchanged()) return undefined;
      await this.write(agent, server, { ...connection, tokens, expiresAt: expiry(tokens), state: "connected" }, scope);
      return tokens.access_token;
    } catch (error) {
      console.error(`[mcp] OAuth refresh failed for server "${server}"`);
      if (await unchanged()) await this.markNeedsReconnect(agent, server, scope);
      return undefined;
    }
  }
}
