import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../index.js";
import type { McpClientHandle } from "../client-manager.js";
import { tempDirs } from "./harness.js";

const dirs = tempDirs();
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await dirs.cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const cases = [
  ["call", "connection"], ["call", "catalog"], ["call", "request"],
  ["read", "connection"], ["read", "request"],
] as const;

describe("MCP Apps total deadlines", () => {
  it("counts connection and catalog time against the same 25-second call deadline", async () => {
    const dir = await dirs.make("mcp-app-total-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "fixture" } } }));
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: string[] = [];
    const extension = createMcpExtension(async () => {
      events.push("connect"); await new Promise((resolve) => setTimeout(resolve, 9_000));
      return {
        async listTools() { events.push("catalog"); await new Promise((resolve) => setTimeout(resolve, 9_000)); return [{ server: "local", name: "data", description: "Data", inputSchema: {}, visibility: ["model", "app"] }]; },
        async callTool() { events.push("call"); entered.resolve(); await release.promise; return {}; },
        async readResource() { return { contents: [] }; }, async close() {},
      };
    });
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    vi.useFakeTimers();
    let settled = false;
    const outcome = extension.mcpApps.callTool({ agentId: "casey" }, "local", "data", {}).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(18_000);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(6_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ name: "McpAppsError", reason: "timeout" });
      release.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(["connect", "catalog", "call"]);
    } finally { release.resolve(); await extension.stop(); }
  });

  it("cancels OAuth discovery without dispatching protected-resource discovery afterward", async () => {
    const dir = await dirs.make("mcp-app-probe-");
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.test/mcp" } } }));
    const entered = deferred<void>();
    const release = deferred<Response>();
    const requests: string[] = [];
    let probeSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      if (requests.length > 1) return new Response("", { status: 404 });
      probeSignal = init?.signal; entered.resolve(); return release.promise;
    });
    const extension = createMcpExtension(async () => { throw new Error("connection must not start"); });
    const agent = { id: "casey", workspaceDir: dir };
    await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
    const controller = new AbortController();
    try {
      const pending = extension.mcpApps.readResource({ agentId: "casey", signal: controller.signal }, "remote", "ui://remote/view");
      await entered.promise;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "McpAppsError", reason: "aborted" });
      release.resolve(new Response("", { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toEqual(["https://remote.example.test/mcp"]);
      expect(probeSignal?.aborted).toBe(true);
    } finally { release.resolve(new Response("", { status: 200 })); await extension.stop(); }
  });

  for (const [operation, phase] of cases) for (const cancellation of ["timeout", "aborted"] as const) {
    it(`${operation} rejects ${cancellation} during ${phase}, stops dispatch and permits a later healthy call`, async () => {
      const dir = await dirs.make("mcp-app-deadline-");
      await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "fixture" } } }));
      const entered = deferred<void>();
      const release = deferred<void>();
      const events: string[] = [];
      let hanging = true;
      let selectedSignal: AbortSignal | undefined;
      async function wait(at: string) {
        if (hanging && phase === at) { entered.resolve(); await release.promise; }
      }
      const handle: McpClientHandle = {
        async listTools(options) {
          events.push("catalog"); selectedSignal = options?.signal;
          await wait("catalog");
          return [{ server: "local", name: "data", description: "Data", inputSchema: {}, visibility: ["model", "app"] }];
        },
        async callTool(_name, _args, options) { events.push("call"); selectedSignal = options?.signal; await wait("request"); return { content: [{ type: "text", text: "healthy" }] }; },
        async readResource(_uri, options) { events.push("read"); selectedSignal = options?.signal; await wait("request"); return { contents: [{ uri: "ui://local/view", text: "healthy" }] }; },
        async close() { events.push("close"); },
      };
      const extension = createMcpExtension(async (_server, _token, options) => {
        events.push("connect"); selectedSignal = options?.signal; await wait("connection"); return handle;
      });
      const agent = { id: "casey", workspaceDir: dir };
      await extension.start({ getDataDir: () => dir, getConfig: () => ({}), getAgent: () => agent });
      vi.useFakeTimers();
      const controller = new AbortController();
      const invoke = () => operation === "call"
        ? extension.mcpApps.callTool({ agentId: "casey", signal: controller.signal }, "local", "data", {})
        : extension.mcpApps.readResource({ agentId: "casey", signal: controller.signal }, "local", "ui://local/view");
      try {
        const pending = invoke();
        const rejection = expect(pending).rejects.toMatchObject({ name: "McpAppsError", reason: cancellation });
        await entered.promise;
        if (cancellation === "aborted") controller.abort();
        else {
          let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
          await vi.advanceTimersByTimeAsync((operation === "call" ? 25_000 : 10_000) - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
        }
        await rejection;
        expect(selectedSignal?.aborted).toBe(true);
        const beforeRelease = events.filter((event) => event !== "close");
        hanging = false; release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(events.filter((event) => event !== "close")).toEqual(beforeRelease);
        expect(events).toContain("close");
        await expect(extension.mcpApps.callTool({ agentId: "casey" }, "local", "data", {})).resolves.toEqual({ content: [{ type: "text", text: "healthy" }] });
      } finally { release.resolve(); await extension.stop(); }
    });
  }
});
