import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpExtension } from "../index.js";
import { routeApp, routeContext, tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.unstubAllEnvs(); await dirs.cleanup(); });

describe("MCP client metadata document", () => {
  it("publishes only public client data without a user or agent in multi-user mode", async () => {
    vi.stubEnv("BASE_URL", "https://yoplai.example.com");
    const home = await dirs.make("mcp-metadata-");
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => home, getConfig: () => ({ extensions: { multiUser: { enabled: true } } }), getAgent: () => undefined });
    const app = routeApp();
    extension.registerRoutes(app);
    const handler = app.routes.get("GET /mcp/oauth/client-metadata.json");
    expect(handler).toBeDefined();
    expect(await handler!(routeContext({}, {}))).toEqual({
      client_id: "https://yoplai.example.com/api/mcp/oauth/client-metadata.json",
      client_name: "Yoplai MCP",
      redirect_uris: ["https://yoplai.example.com/api/mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it.each([
    "http://yoplai.example.com", "http://localhost:4000", "https://localhost",
    "https://gateway.localhost", "https://127.0.0.1", "https://127.42.1.2", "https://[::1]", "/",
  ])("returns 404 for an unavailable document at %s", async (origin) => {
    vi.stubEnv("BASE_URL", origin);
    const home = await dirs.make("mcp-metadata-");
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => home, getConfig: () => ({}), getAgent: () => undefined });
    const app = routeApp();
    extension.registerRoutes(app);
    expect(await app.routes.get("GET /mcp/oauth/client-metadata.json")!(routeContext({}, {}))).toEqual({ body: "Not found", status: 404 });
  });

  it.each([
    { env: "https://yoplai.example.com/", configEnv: "https://config.example.test", baseUrl: "https://server.example.test", expected: "https://yoplai.example.com" },
    { env: "", configEnv: "https://config.example.test/", baseUrl: "https://server.example.test", expected: "https://config.example.test" },
    { env: "", configEnv: "", baseUrl: "https://server.example.test/", expected: "https://server.example.test" },
  ])("uses origin precedence with $expected", async ({ env, configEnv, baseUrl, expected }) => {
    vi.stubEnv("BASE_URL", env);
    const home = await dirs.make("mcp-metadata-");
    const extension = createMcpExtension();
    await extension.start({ getDataDir: () => home, getConfig: () => ({ env: { BASE_URL: configEnv }, server: { baseUrl } }), getAgent: () => undefined });
    const app = routeApp();
    extension.registerRoutes(app);
    expect(await app.routes.get("GET /mcp/oauth/client-metadata.json")!(routeContext({}, {}))).toMatchObject({
      client_id: `${expected}/api/mcp/oauth/client-metadata.json`,
      redirect_uris: [`${expected}/api/mcp/oauth/callback`],
    });
  });
});
