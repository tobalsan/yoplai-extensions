import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { SdkMcpClientHandle } from "../client-manager.js";
import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { credentials } from "./credentials.js";
import { tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { await dirs.cleanup(); });

/** Stateful Streamable HTTP MCP server that counts sessions and can forget them, like an idle sweep. */
async function server() {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let initialized = 0;
  const httpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const id = req.headers["mcp-session-id"];
    const existing = typeof id === "string" ? transports.get(id) : undefined;
    if (existing) return existing.handleRequest(req, res, body);
    if (id) { res.writeHead(404).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => { initialized++; transports.set(sessionId, transport); },
    });
    const mcp = new McpServer({ name: "fixture", version: "1" });
    mcp.registerTool("lookup", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    sessions: () => initialized,
    forgetSessions: () => transports.clear(),
    close: () => new Promise<void>((resolve) => { httpServer.closeAllConnections(); httpServer.close(() => resolve()); }),
  };
}

describe("OAuth MCP call sessions over Streamable HTTP", () => {
  it("opens one session for repeated calls and resends once after the server forgot it", async () => {
    const upstream = await server();
    const dir = await dirs.make("mcp-call-sessions-http-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: upstream.url, oauth: { clientId: "client" } } } }));
    const host = credentials();
    const store = new McpOAuthStore(dir, "http://localhost/callback", host, () => ({ url: upstream.url, clientId: "client" }));
    await store.write("casey", "remote", { client: { client_id: "client", redirect_uris: ["http://localhost/callback"] }, tokens: { access_token: "token", token_type: "Bearer" }, connectedAt: new Date().toISOString(), authorizationServerUrl: "https://auth.example.test", state: "connected" });
    const extension = createMcpExtension((config, token, options) => SdkMcpClientHandle.connect(config, token, false, options));
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ credentials: host, getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    try {
      const [tool] = await extension.getAgentTools(agent, { config: {} });
      expect(upstream.sessions()).toBe(1);
      for (let index = 0; index < 20; index++) await expect(tool!.execute({})).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
      expect(upstream.sessions()).toBe(2);
      upstream.forgetSessions();
      await expect(tool!.execute({})).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
      expect(upstream.sessions()).toBe(3);
    } finally {
      await extension.stop();
      await upstream.close();
    }
  });
});
