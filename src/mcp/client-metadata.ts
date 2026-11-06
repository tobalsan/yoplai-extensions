import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

/** One public client document per gateway; remote authorization servers cannot fetch loopback origins. */
export function buildOAuthClientMetadata(redirectUri: string): { url: string; document: OAuthClientMetadata & { client_id: string } } | undefined {
  let callback: URL;
  try { callback = new URL(redirectUri); } catch { return undefined; }
  const hostname = callback.hostname.toLowerCase().replace(/\.$/, "");
  if (callback.protocol !== "https:" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d+){3}$/.test(hostname)) return undefined;
  const url = `${callback.origin}/api/mcp/oauth/client-metadata.json`;
  return {
    url,
    document: { client_id: url, client_name: "Yoplai MCP", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
  };
}
