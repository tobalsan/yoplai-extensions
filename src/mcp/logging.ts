export type McpLogPath = "tools" | "status" | "call";
export type McpLogLevel = "info" | "warn" | "error";
export interface McpLogContext { agentId: string; userId?: string; path: McpLogPath }
export interface McpLogEvent extends McpLogContext {
  server: string;
  reason: string;
  scope?: "personal" | "team";
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/\?[^\s"'<>]*/g, "")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:[^\r\n]*/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted]")
    .replace(/\b(?:access_token|refresh_token|id_token|client_secret|token|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

export function logMcpUnavailable(level: McpLogLevel, message: string, fields: McpLogEvent): void {
  const line = JSON.stringify({
    level,
    msg: `[mcp] server "${fields.server}" unavailable: ${sanitizeMessage(message)}`,
    ...fields,
    userId: fields.userId ?? "anonymous",
  });
  if (level === "info") console.log(line);
  else console.error(line);
}
