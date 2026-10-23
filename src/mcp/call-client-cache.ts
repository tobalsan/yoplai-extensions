import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpClientManager, McpToolDefinition } from "./client-manager.js";

export interface McpCallIdentity {
  agentId: string;
  configPath: string;
  revision: string;
  server: string;
  requester?: string;
  scope: string;
  sessionId?: string;
  credential: string;
  credentialVersion: number;
}

type CallClient = { manager: McpClientManager; tools: McpToolDefinition[] };
type Entry = { identity: McpCallIdentity; client: Promise<CallClient>; active: number; timer?: ReturnType<typeof setTimeout> };

/** Owns call clients separately from tool discovery, with one creation per chat. */
export class McpCallClientCache {
  private readonly entries = new Map<string, Entry>();
  private readonly closing = new Set<Promise<void>>();

  async run(identity: McpCallIdentity, create: () => Promise<CallClient>, call: (client: CallClient) => Promise<unknown>): Promise<unknown> {
    const reusable = Boolean(identity.requester && identity.sessionId);
    const key = JSON.stringify(identity);
    for (let attempt = 0; ; attempt++) {
      let entry = reusable ? this.entries.get(key) : undefined;
      if (!entry) {
        entry = { identity, client: create(), active: 0 };
        if (reusable) this.entries.set(key, entry);
      }
      entry.active++;
      clearTimeout(entry.timer);
      let connected = false;
      try {
        const client = await entry.client;
        connected = true;
        const result = await call(client);
        if (isNotConnected(result)) await this.remove(key, entry);
        return attempt === 0 ? result : withSessionReset(result);
      } catch (error) {
        const expired = error instanceof StreamableHTTPError && error.code === 404;
        if (!connected || expired) await this.remove(key, entry);
        if (!expired || attempt > 0) throw error;
      } finally {
        entry.active--;
        if (!reusable) await this.closeEntry(entry);
        else if (entry.active === 0 && this.entries.get(key) === entry) {
          entry.timer = setTimeout(() => { void this.remove(key, entry); }, 15 * 60_000);
          entry.timer.unref?.();
        }
      }
    }
  }

  private async closeEntry(entry: Entry): Promise<void> {
    try { await (await entry.client).manager.close(); }
    catch { /* Creation already reports its error to the caller. */ }
  }

  private async remove(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    const closing = this.closeEntry(entry);
    this.closing.add(closing);
    try { await closing; }
    finally { this.closing.delete(closing); }
  }

  async invalidate(matches: (identity: McpCallIdentity) => boolean): Promise<void> {
    await Promise.all([...this.entries].filter(([, entry]) => matches(entry.identity)).map(([key, entry]) => this.remove(key, entry)));
  }

  async close(): Promise<void> {
    await this.invalidate(() => true);
    await Promise.all([...this.closing]);
  }
}

function isNotConnected(result: unknown): boolean {
  return typeof result === "object" && result !== null && "connected" in result && result.connected === false && "provider" in result && result.provider === "mcp";
}

function withSessionReset(result: unknown): unknown {
  const response = typeof result === "object" && result !== null ? result : { result };
  const content = "content" in response && Array.isArray(response.content) ? response.content : [];
  return { ...response, sessionReset: true, content: [...content, { type: "text", text: "This call used a new MCP session. Server state, such as the selected tenant, has returned to its default value." }] };
}
