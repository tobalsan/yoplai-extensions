import { describe, expect, it } from "vitest";

import { parseMcpConfig } from "../loader.js";

describe("mcp config loader", () => {
  it("does not interpolate saved icon metadata into connection configuration", () => {
    const loaded = parseMcpConfig(JSON.stringify({ mcpServers: {
      remote: { url: "https://example.test/mcp", serverIcon: "data:image/svg+xml,%3Csvg%3E${NAME}%3C/svg%3E" },
    } }), {});
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toEqual([{ type: "http", name: "remote", url: "https://example.test/mcp" }]);
  });

  it("parses stdio and HTTP servers with env interpolation", () => {
    const loaded = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          local: {
            command: "npx",
            args: ["-y", "${PKG}", "--token=${TOKEN}"],
            env: { API_TOKEN: "${TOKEN}" },
          },
          remote: {
            url: "https://example.com/${TENANT}/mcp",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        },
      }),
      { PKG: "@example/mcp", TOKEN: "secret", TENANT: "acme" }
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toEqual([
      {
        type: "stdio",
        name: "local",
        command: "npx",
        args: ["-y", "@example/mcp", "--token=secret"],
        env: { API_TOKEN: "secret" },
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.com/acme/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
  });

  it("reports undefined interpolation as a per-server load error", () => {
    const loaded = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          broken: { url: "https://example.com/${TOKEN}/mcp" },
          healthy: { command: "node", args: ["server.js"] },
        },
      }),
      {}
    );

    expect(loaded.servers).toEqual([
      { type: "stdio", name: "healthy", command: "node", args: ["server.js"] },
    ]);
    expect(loaded.errors).toEqual([
      { server: "broken", message: 'Env var "TOKEN" is not defined' },
    ]);
  });

  it("rejects malformed root configs", () => {
    expect(() => parseMcpConfig(JSON.stringify({ servers: {} }), {})).toThrow();
  });
});
