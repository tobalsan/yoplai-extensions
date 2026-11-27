import { getEventListeners } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { McpClientManager, SdkMcpClientHandle } from "../client-manager.js";

const config = { name: "memory", type: "stdio", command: "unused" } as const;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function connect(server: McpServer | Server, signal?: AbortSignal) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  cleanup.push(() => server.close());
  const client = await SdkMcpClientHandle.connect(config, undefined, false, {
    signal, transportFactory: () => clientTransport,
  });
  cleanup.push(() => client.close());
  return client;
}

async function schemaServer(outputSchema: Record<string, unknown>) {
  const server = new Server({ name: "unchecked-output", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "answer", inputSchema: { type: "object" }, outputSchema,
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [], structuredContent: request.params.arguments ?? {},
  }));
  return connect(server);
}

const listedTool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

describe("MCP tool pagination", () => {
  it("returns all three pages in server order", async () => {
    const server = new Server({ name: "paged-tools", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      switch (params?.cursor) {
        case undefined: return { tools: [listedTool("zebra"), listedTool("otter")], nextCursor: "second" };
        case "second": return { tools: [listedTool("seal"), listedTool("tern")], nextCursor: "third" };
        case "third": return { tools: [listedTool("ibis")] };
        default: throw new Error("Unknown cursor");
      }
    });
    const client = await connect(server);
    expect((await client.listTools()).map(({ name }) => name)).toEqual(["zebra", "otter", "seal", "tern", "ibis"]);
  });

  it("stops on an empty cursor", async () => {
    const server = new Server({ name: "empty-cursor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      if (params?.cursor !== undefined) throw new Error("Listing should have ended");
      return { tools: [listedTool("lookup")], nextCursor: "" };
    });
    const client = await connect(server);
    expect((await client.listTools()).map(({ name }) => name)).toEqual(["lookup"]);
  });

  it("rejects a null cursor as an invalid MCP response", async () => {
    const server = new Server({ name: "null-cursor", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [], nextCursor: null }));
    const client = await connect(server);
    await expect(client.listTools()).rejects.toThrow(/nextCursor/);
  });

  it("validates structured output for a tool from an earlier page", async () => {
    const server = new Server({ name: "paged-output", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => params?.cursor === "second"
      ? { tools: [listedTool("summarize")] }
      : { tools: [{
        ...listedTool("count"),
        outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      }], nextCursor: "second" });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [], structuredContent: { count: "seven" },
    }));
    const client = await connect(server);
    await client.listTools();
    await expect(client.callTool("count", {})).rejects.toThrow("Structured content does not match");
  });

  it("rejects a repeated cursor with the server name", async () => {
    const server = new Server({ name: "repeated-cursor", version: "1" }, { capabilities: { tools: {} } });
    let pages = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [], nextCursor: ++pages < 3 ? "repeat" : undefined,
    }));
    const client = await connect(server);
    await expect(client.listTools()).rejects.toThrow(/MCP server "memory".*repeated cursor/i);
  });

  it("rejects a catalog that requires more than 1000 pages", async () => {
    const server = new Server({ name: "long-catalog", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      const page = Number(params?.cursor ?? "1");
      return { tools: [], nextCursor: page < 1001 ? String(page + 1) : undefined };
    });
    const client = await connect(server);
    await expect(client.listTools()).rejects.toThrow(/MCP server "memory".*1000 pages/i);
  });

  it("cancels a pending page without returning a partial catalog", async () => {
    const caller = new AbortController();
    const server = new Server({ name: "slow-catalog", version: "1" }, { capabilities: { tools: {} } });
    let cancellations = 0;
    server.setNotificationHandler(CancelledNotificationSchema, async () => {
      cancellations++;
    });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      if (params?.cursor === "second") {
        caller.abort(new Error("catalog cancelled"));
        return new Promise(() => {});
      }
      return { tools: [listedTool("lookup")], nextCursor: "second" };
    });
    const client = await connect(server);
    await expect(client.listTools({ signal: caller.signal })).rejects.toThrow("catalog cancelled");
    await new Promise(setImmediate);
    expect(cancellations).toBe(1);
  }, 1_000);
});

describe("MCP client memory", () => {
  it("compiles identical output schemas once across 200 rounds and fresh clients", async () => {
    const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
    for (let connection = 0; connection < 4; connection++) {
      const server = new McpServer({ name: "schema-memory", version: "1" });
      server.registerTool("answer", {
        outputSchema: { answer: z.number().describe("schema-memory-answer") },
      }, async () => ({ content: [], structuredContent: { answer: 42 } }));
      const client = await connect(server);
      for (let round = 0; round < 50; round++) {
        await client.listTools();
        await expect(client.callTool("answer", {})).resolves.toEqual({ content: [], structuredContent: { answer: 42 } });
      }
      await client.close();
    }
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it("validates each server schema independently when their $id is identical", async () => {
    const numberClient = await schemaServer({
      $id: "https://memory.test/shared-output", type: "object",
      properties: { answer: { type: "number" } }, required: ["answer"],
    });
    const stringClient = await schemaServer({
      $id: "https://memory.test/shared-output", type: "object",
      properties: { answer: { type: "string" } }, required: ["answer"],
    });
    await numberClient.listTools();
    await stringClient.listTools();
    await expect(numberClient.callTool("answer", { answer: 42 })).resolves.toMatchObject({ structuredContent: { answer: 42 } });
    await expect(stringClient.callTool("answer", { answer: "forty-two" })).resolves.toMatchObject({ structuredContent: { answer: "forty-two" } });
    await expect(numberClient.callTool("answer", { answer: "wrong" })).rejects.toThrow("Structured content does not match");
    await expect(stringClient.callTool("answer", { answer: 42 })).rejects.toThrow("Structured content does not match");
  });

  it("keeps caller abort listeners flat after connect and 200 request rounds", async () => {
    const caller = new AbortController();
    const baseline = getEventListeners(caller.signal, "abort").length;
    const server = new McpServer({ name: "listeners", version: "1" });
    server.registerTool("ping", {}, async () => ({ content: [] }));
    server.registerResource("view", "ui://memory/view", {}, async () => ({
      contents: [{ uri: "ui://memory/view", text: "memory" }],
    }));
    const cancelled = vi.fn();
    server.server.setNotificationHandler(CancelledNotificationSchema, cancelled);
    const client = await connect(server, caller.signal);
    for (let round = 0; round < 200; round++) {
      await client.listTools({ signal: caller.signal });
      await client.callTool("ping", {}, { signal: caller.signal });
      await client.readResource("ui://memory/view", { signal: caller.signal });
    }
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(baseline);
    expect(caller.signal.aborted).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    await client.close();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(baseline);
  });

  it("still rejects malformed structured content without a schema $id", async () => {
    const client = await schemaServer({
      type: "object", properties: { count: { type: "integer" } }, required: ["count"],
    });
    await client.listTools();
    await expect(client.callTool("answer", { count: 7 })).resolves.toMatchObject({ structuredContent: { count: 7 } });
    await expect(client.callTool("answer", { count: "seven" })).rejects.toThrow("Structured content does not match");
  });

  it("releases manager and caller signals, composites and one-off connections", async () => {
    const owner = new AbortController();
    const caller = new AbortController();
    const server = new McpServer({ name: "manager-memory", version: "1" });
    server.registerTool("ping", {}, async () => ({ content: [] }));
    server.registerResource("view", "ui://memory/view", {}, async () => ({ contents: [{ uri: "ui://memory/view", text: "manager" }] }));
    const client = await connect(server, owner.signal);
    const lists = vi.spyOn(client, "listTools");
    const calls = vi.spyOn(client, "callTool");
    const reads = vi.spyOn(client, "readResource");
    const closed = vi.fn();
    server.server.onclose = closed;
    const manager = new McpClientManager([config], {
      signal: owner.signal, statusOnly: true, throwOnError: true,
      clientFactory: async () => client,
    });
    cleanup.push(() => manager.close());
    await manager.connect();
    for (let round = 0; round < 200; round++) {
      await manager.listTools({ signal: caller.signal });
      await manager.invokeTool("memory", "ping", {}, { signal: caller.signal });
      await manager.readResource("memory", "ui://memory/view", { signal: caller.signal });
    }
    for (const options of [
      ...lists.mock.calls.map(([options]) => options),
      ...calls.mock.calls.map(([, , options]) => options),
      ...reads.mock.calls.map(([, options]) => options),
    ]) {
      expect(options?.signal).toBeDefined();
      expect(getEventListeners(options!.signal!, "abort")).toHaveLength(0);
    }
    await manager.close();
    expect(manager.hasClient("memory")).toBe(false);
    expect(closed).toHaveBeenCalled();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("cancels pending requests promptly and cleans up after errors and pre-aborted callers", async () => {
    const caller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const server = new McpServer({ name: "cancellation-memory", version: "1" });
    server.registerTool("wait", {}, async (_extra) => {
      started();
      return new Promise(() => {});
    });
    server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const client = await connect(server, caller.signal);
    const pending = client.callTool("wait", {}, { signal: caller.signal });
    const rejected = expect(pending).rejects.toThrow(/viewer left/);
    await waiting;
    caller.abort(new Error("viewer left"));
    await rejected;
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    await expect(client.callTool("ping", {}, { signal: caller.signal })).rejects.toThrow(/viewer left/);
    const healthy = new AbortController();
    await expect(client.readResource("ui://memory/missing", { signal: healthy.signal })).rejects.toThrow();
    expect(getEventListeners(healthy.signal, "abort")).toHaveLength(0);
    await expect(client.callTool("ping", {}, { signal: healthy.signal })).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });
    expect(getEventListeners(healthy.signal, "abort")).toHaveLength(0);
  }, 1_000);

});
