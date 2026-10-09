import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Best-effort "who is connected" label for an OAuth MCP connection; never throws and stays within one deadline. */

export interface AccountTool { name: string; inputSchema?: { required?: string[] }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface AccountSession {
  listTools(): Promise<{ tools: AccountTool[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}
export type AccountSessionFactory = (url: string, accessToken: string, signal?: AbortSignal) => Promise<AccountSession>;

export interface AccountLookup { serverUrl: string; authorizationServerUrl: string; tokens: OAuthTokens; connect?: AccountSessionFactory; timeoutMs?: number }

type HostLookup = { rest: string } | { tool: string; args: Record<string, unknown> };
/** MCP server host -> where the signed-in user can be read when the token carries no identity. */
const HOST_LOOKUPS: Record<string, HostLookup> = {
  "mcp.pipedrive.ai": { rest: "https://api.pipedrive.com/api/v1/users/me" },
  "mcp.notion.com": { tool: "notion-get-users", args: { user_id: "self" } },
  "mcp.linear.app": { tool: "get_user", args: { query: "me" } },
};

const WHOAMI_TOOLS = new Set(["whoami", "me", "getme", "currentuser", "getcurrentuser", "userinfo", "getuserinfo", "myprofile", "getmyprofile", "accountinfo", "getaccountinfo", "viewer", "getviewer"]);
const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/;
const MAX_LABEL = 200;

const connectSession: AccountSessionFactory = async (url, accessToken, signal) => {
  const client = new Client({ name: "yoplai-account-lookup", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` }, signal, redirect: "error" } });
  try { await client.connect(transport); } catch (error) { await transport.close().catch(() => undefined); throw error; }
  return client as unknown as AccountSession;
};

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, MAX_LABEL) : undefined;
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".");
  if (part?.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part[1]!, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function findField(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(value)) for (const key of keys) { const found = clean(record[key]); if (found) return found; }
  for (const child of Object.values(record)) { const found = findField(child, keys, depth + 1); if (found) return found; }
  return undefined;
}

/** Email field first, then an email in plain text, then a display name. */
export function extractAccountLabel(result: unknown): string | undefined {
  const texts: string[] = [];
  const objects: unknown[] = [];
  if (typeof result === "string") texts.push(result);
  else if (result && typeof result === "object") {
    const record = result as { content?: unknown; structuredContent?: unknown };
    if (record.structuredContent) objects.push(record.structuredContent);
    if (Array.isArray(record.content)) for (const item of record.content) if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
    if (!record.content && !record.structuredContent) objects.push(result);
  }
  for (const text of texts) { try { objects.push(JSON.parse(text)); } catch { /* plain text */ } }
  for (const object of objects) { const email = findField(object, ["email"]); if (email) return email; }
  for (const text of texts) { const email = clean(EMAIL.exec(text)?.[0]); if (email) return email; }
  for (const object of objects) { const name = findField(object, ["name", "displayName"]); if (name) return name; }
  return undefined;
}

/** Bearer requests never follow redirects, so the token only reaches the URL we chose. */
async function fetchJson(url: string, accessToken: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal, redirect: "error" });
  return response.ok ? await response.json() : undefined;
}

/** Only send the token to a userinfo endpoint served over HTTPS by the authorization server's own host. */
export function trustedUserinfoEndpoint(endpoint: string | undefined, authorizationServerUrl: string): string | undefined {
  try {
    const target = new URL(endpoint ?? "");
    return target.protocol === "https:" && target.host === new URL(authorizationServerUrl).host ? target.toString() : undefined;
  } catch { return undefined; }
}

async function viaSession(lookup: AccountLookup, signal: AbortSignal, run: (session: AccountSession) => Promise<string | undefined>): Promise<string | undefined> {
  const session = await (lookup.connect ?? connectSession)(lookup.serverUrl, lookup.tokens.access_token, signal);
  const close = () => { void session.close().catch(() => undefined); };
  signal.addEventListener("abort", close, { once: true });
  try { return await run(session); } finally { signal.removeEventListener("abort", close); close(); }
}

function isSafeWhoami(tool: AccountTool): boolean {
  return WHOAMI_TOOLS.has(tool.name.toLowerCase().replace(/[_-]/g, ""))
    && !tool.inputSchema?.required?.length
    && tool.annotations?.readOnlyHint !== false
    && tool.annotations?.destructiveHint !== true;
}

async function lookupAccount(lookup: AccountLookup, signal: AbortSignal): Promise<string | undefined> {
  const { tokens } = lookup;
  const idClaims = jwtClaims(tokens.id_token as string | undefined);
  const fromId = clean(idClaims?.email) ?? clean(idClaims?.name) ?? clean(idClaims?.preferred_username);
  if (fromId) return fromId;
  const fromAccess = clean(jwtClaims(tokens.access_token)?.email);
  if (fromAccess) return fromAccess;

  try {
    const metadata = await discoverAuthorizationServerMetadata(lookup.authorizationServerUrl, { fetchFn: (input, init) => fetch(input, { ...init, signal }) }) as Record<string, unknown> | undefined;
    const endpoint = trustedUserinfoEndpoint(clean(metadata?.userinfo_endpoint), lookup.authorizationServerUrl);
    const info = endpoint ? await fetchJson(endpoint, tokens.access_token, signal) as Record<string, unknown> | undefined : undefined;
    const label = clean(info?.email) ?? clean(info?.name);
    if (label) return label;
  } catch { /* try the next source */ }

  const known = HOST_LOOKUPS[new URL(lookup.serverUrl).host.toLowerCase()];
  try {
    if (known && "rest" in known) { const label = extractAccountLabel(await fetchJson(known.rest, tokens.access_token, signal)); if (label) return label; }
    else if (known) {
      const label = await viaSession(lookup, signal, async (session) => extractAccountLabel(await session.callTool({ name: known.tool, arguments: known.args })));
      if (label) return label;
    }
  } catch { /* try the next source */ }

  try {
    if (signal.aborted) return undefined;
    return await viaSession(lookup, signal, async (session) => {
      const tool = (await session.listTools()).tools.find(isSafeWhoami);
      return tool ? extractAccountLabel(await session.callTool({ name: tool.name, arguments: {} })) : undefined;
    });
  } catch { return undefined; }
}

export async function resolveAccountLabel(lookup: AccountLookup): Promise<string | undefined> {
  // One deadline aborts every request and closes any open MCP session.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupAccount(lookup, controller.signal).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, lookup.timeoutMs ?? 5_000); }),
    ]);
  } catch { return undefined; } finally { clearTimeout(timer); controller.abort(); }
}
