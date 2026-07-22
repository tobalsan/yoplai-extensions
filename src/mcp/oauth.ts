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

  constructor(private readonly dataDir: string, private readonly redirectUri: string) {}

  private file(agent: string, server: string): string {
    return path.join(this.dataDir, "mcp", "oauth", filePart(agent), `${filePart(server)}.json`);
  }

  async read(agent: string, server: string): Promise<OAuthConnection | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.file(agent, server), "utf8")) as OAuthConnection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(agent: string, server: string, connection: OAuthConnection): Promise<void> {
    const file = this.file(agent, server);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(connection), { mode: 0o600 });
    await fs.chmod(file, 0o600);
  }

  async delete(agent: string, server: string): Promise<void> {
    await fs.rm(this.file(agent, server), { force: true });
  }

  async revoke(agent: string, server: string): Promise<void> {
    const connection = await this.read(agent, server);
    if (!connection) return;
    try {
      const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl);
      const endpoint = (metadata as Record<string, unknown> | undefined)?.revocation_endpoint;
      if (typeof endpoint !== "string") return;
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: connection.tokens.refresh_token ?? connection.tokens.access_token, client_id: connection.client.client_id }),
      });
    } catch {
      // Revocation is best-effort; local token deletion still disconnects the agent.
    }
  }

  async markNeedsReconnect(agent: string, server: string): Promise<void> {
    const connection = await this.read(agent, server);
    if (connection) await this.write(agent, server, { ...connection, state: "needs_reconnect" });
  }

  async begin(agent: string, server: string, url: string): Promise<{ state: string; authorizationUrl: string }> {
    const info = await discoverOAuthServerInfo(url);
    if (!info.authorizationServerMetadata?.registration_endpoint) {
      throw new Error("OAuth server does not support dynamic client registration");
    }
    const existing = await this.read(agent, server);
    const client = existing?.client ?? await registerClient(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientMetadata: { client_name: "AIHub MCP", redirect_uris: [this.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    });
    const state = crypto.randomBytes(32).toString("base64url");
    const auth = await startAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: client,
      redirectUrl: this.redirectUri,
      state,
      resource: new URL(url),
    });
    this.pending.set(state, { agent, server, url, codeVerifier: auth.codeVerifier, createdAt: Date.now(), client });
    return { state, authorizationUrl: auth.authorizationUrl.toString() };
  }

  async finish(state: string, code: string): Promise<{ agent: string; server: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) throw new Error("OAuth state is invalid or expired");
    const info = await discoverOAuthServerInfo(pending.url);
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata: info.authorizationServerMetadata, clientInformation: pending.client, authorizationCode: code, codeVerifier: pending.codeVerifier, redirectUri: this.redirectUri, resource: new URL(pending.url) });
    await this.write(pending.agent, pending.server, { client: pending.client, tokens, connectedAt: new Date().toISOString(), authorizationServerUrl: info.authorizationServerUrl, expiresAt: expiry(tokens), state: "connected" });
    return pending;
  }

  async accessToken(agent: string, server: string, skewMs = 60_000): Promise<string | undefined> {
    const connection = await this.read(agent, server);
    if (!connection) return undefined;
    if (connection.state === "needs_reconnect") return undefined;
    if (!connection.expiresAt || Date.parse(connection.expiresAt) - Date.now() > skewMs) return connection.tokens.access_token;
    if (!connection.tokens.refresh_token) {
      await this.markNeedsReconnect(agent, server);
      return undefined;
    }
    try {
      const metadata = await discoverAuthorizationServerMetadata(connection.authorizationServerUrl);
      const tokens = await refreshAuthorization(connection.authorizationServerUrl, { metadata, clientInformation: connection.client, refreshToken: connection.tokens.refresh_token });
      await this.write(agent, server, { ...connection, tokens, expiresAt: expiry(tokens), state: "connected" });
      return tokens.access_token;
    } catch {
      await this.markNeedsReconnect(agent, server);
      return undefined;
    }
  }
}
