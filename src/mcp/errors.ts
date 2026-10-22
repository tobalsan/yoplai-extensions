import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpTimeoutError } from "./timeout.js";

export type McpErrorCategory = "authentication" | "network" | "timeout" | "protocol" | "configuration";

export function classifyMcpError(error: unknown): McpErrorCategory {
  if (error instanceof McpTimeoutError) return "timeout";
  if (error instanceof UnauthorizedError) return "authentication";
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; status?: unknown; name?: unknown; cause?: unknown };
    if (value.code === "ERR_INVALID_URL" || value.code === "ENOENT" || value.code === "EACCES") return "configuration";
    if (value.code === 401 || value.status === 401 || value.name === "UnauthorizedError" || value.name === "InvalidGrantError" || value.name === "InvalidTokenError" || value.name === "InvalidClientError" || value.name === "UnauthorizedClientError") return "authentication";
    if (value.code === -32001 || value.name === "TimeoutError" || value.name === "AbortError" || value.code === "ETIMEDOUT" || value.code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
    if (typeof value.code === "string" && /^(ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET|UND_ERR)/.test(value.code)) return "network";
    if (value.cause) {
      const category = classifyMcpError(value.cause);
      if (category !== "protocol") return category;
    }
    if (value.code === -32600 || value.code === -32601 || value.code === -32602 || value.code === -32700) return "protocol";
  }
  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) return "network";
  if (isUnauthorized(error)) return "authentication";
  return "protocol";
}

export function isUnauthorized(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (typeof error === "object" && error !== null && "code" in error && error.code === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthori[sz]ed/i.test(message);
}
