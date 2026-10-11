import { credentials } from "./credentials.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveAccountLabel = vi.hoisted(() => vi.fn());
vi.mock("../account.js", () => ({ resolveAccountLabel }));

import { createMcpExtension } from "../index.js";
import { McpOAuthStore } from "../oauth.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { resolveAccountLabel.mockReset(); vi.unstubAllGlobals(); await dirs.cleanup(); });

const app = routeApp;
const context = routeContext;

describe("OAuth status account", () => {
  it("backfills a missing account once, persists it, and reports it", async () => {
    const work = await dirs.make("mcp-account-");
    await fs.writeFile(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { claap: { url: "https://api.claap.io/mcp" } } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const hostCredentials = credentials();
    const store = new McpOAuthStore(work, "http://localhost/callback", hostCredentials);
    await store.write("casey", "claap", { client: { client_id: "client", redirect_uris: [] }, tokens: { access_token: "tok", token_type: "Bearer" }, connectedAt: "2025-01-01T00:00:00.000Z", authorizationServerUrl: "https://auth.test", state: "connected" });
    resolveAccountLabel.mockResolvedValue("me@example.test");
    const extension = createMcpExtension();
    await extension.start({ credentials: hostCredentials, getDataDir: () => work, getConfig: () => ({}), getAgent: () => ({ id: "casey", workspace: work, extensions: { mcp: { enabled: true } } }) });
    const routes = app(); extension.registerRoutes(routes);
    const status = routes.routes.get("GET /mcp/oauth/status")!;
    await expect(status(context({ agent: "casey" }))).resolves.toMatchObject({ servers: [{ name: "claap", state: "connected", account: "me@example.test" }] });
    await expect(store.read("casey", "claap")).resolves.toMatchObject({ account: "me@example.test", tokens: { access_token: "tok" } });
    await status(context({ agent: "casey" }));
    expect(resolveAccountLabel).toHaveBeenCalledTimes(1);
    expect(resolveAccountLabel).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: "https://api.claap.io/mcp", tokens: expect.objectContaining({ access_token: "tok" }) }));
  });
});
