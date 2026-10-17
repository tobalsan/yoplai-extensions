import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tools(allowWrite = false) {
  const hostPath = await mkdtemp(path.join(tmpdir(), "drive-files-"));
  roots.push(hostPath);
  const mounted = await extension.getAgentTools({ id: "shared-agent", extensions: { googleDrive: { allowWrite } } }, {
    config: {},
    resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test-token", scopes: [] }),
  });
  return { hostPath, context: { agentId: "shared-agent", sessionId: "conversation-a", userId: "alice", conversationFiles: { hostPath, runtimePath: "/workspace/files" } },
    execute: (name: string, params: unknown, context?: object) => {
      const tool = mounted.find((item) => item.name === `googleDrive_${name}`);
      if (!tool) throw new Error(`Tool ${name} unavailable`);
      return tool.execute(params, context ?? { agentId: "shared-agent", sessionId: "conversation-a", userId: "alice", conversationFiles: { hostPath, runtimePath: "/workspace/files" } });
    }, names: mounted.map((item) => item.name) };
}
function google(...responses: Response[]) {
  const pending = [...responses];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const response = pending.shift();
    if (!response) throw new Error("Unexpected Google request");
    return response;
  }));
}
function metadata(mimeType = "application/pdf", name = "brief.pdf", extra = {}) {
  return Response.json({ id: "file-1", name, mimeType, capabilities: { canDownload: true }, ...extra });
}
it("downloads original bytes into the calling conversation, including shared-drive files", async () => {
  const run = await tools();
  const bytes = new Uint8Array([0, 255, 80, 75, 13, 10]);
  const pending = [metadata(), new Response(bytes)];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    return pending.shift()!;
  }));
  const result = await run.execute("download_file", { fileId: "file-1" }) as { path: string };
  expect(result).toMatchObject({ fileId: "file-1", name: "brief.pdf", mimeType: "application/pdf", bytes: 6 });
  expect(result.path.startsWith("/workspace/files/")).toBe(true);
  expect(await readFile(path.join(run.hostPath, path.basename(result.path)))).toEqual(Buffer.from([0, 255, 80, 75, 13, 10]));
});
it.each([
  ["document", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["spreadsheet", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["presentation", "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
])("exports native %s into its matching Office format", async (native, suffix, mime) => {
  const run = await tools();
  const pending = [metadata(`application/vnd.google-apps.${native}`, "Quarterly"), new Response("Office bytes")];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/export")) expect(url.searchParams.get("mimeType")).toBe(mime);
    else expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    return pending.shift()!;
  }));
  const result = await run.execute("download_file", { fileId: "file-1" }) as { path: string };
  expect(result).toMatchObject({ name: `Quarterly.${suffix}`, mimeType: mime, bytes: 12 });
  expect(await readFile(path.join(run.hostPath, path.basename(result.path)), "utf8")).toBe("Office bytes");
});
it.each(["folder", "shortcut", "drawing", "form"])("rejects unsupported native %s without leaving files", async (kind) => {
  const run = await tools();
  google(metadata(`application/vnd.google-apps.${kind}`), new Response("not downloadable"));
  await expect(run.execute("download_file", { fileId: "file-1" })).rejects.toThrow(/unsupported|cannot download/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});
it("honors the owner's download restriction", async () => {
  const run = await tools();
  google(metadata("application/pdf", "restricted.pdf", { capabilities: { canDownload: false } }), new Response("private"));
  await expect(run.execute("download_file", { fileId: "file-1" })).rejects.toThrow(/download.*(disabled|allowed|restricted)/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});
it.each([["application/pdf", 26_214_400], ["application/vnd.google-apps.document", 10_000_000]])("caps streamed %s bytes without Content-Length and removes partial output", async (mime, limit) => {
  const run = await tools();
  let sent = 0;
  google(metadata(mime), new Response(new ReadableStream({ pull(controller) {
    if (sent > limit) return controller.close();
    controller.enqueue(new Uint8Array(1_000_000));
    sent += 1_000_000;
  } })));
  await expect(run.execute("download_file", { fileId: "file-1" })).rejects.toThrow(/(25 MiB|10 MB).*limit|exceeds/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});
it("cancels a hung download and removes its partial file", async () => {
  const run = await tools();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let reads = 0;
  google(metadata(), new Response(new ReadableStream({ pull(stream) {
    if (reads++ === 0) stream.enqueue(new Uint8Array([1, 2, 3]));
    else { started(); return new Promise(() => {}); }
  } })));
  const pending = run.execute("download_file", { fileId: "file-1" }, { ...run.context, signal: controller.signal });
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(await readdir(run.hostPath)).toEqual([]);
});
it.each(["../../outside.pdf", "..\\..\\outside.pdf", ".", "\u0000report:*.pdf", "a".repeat(400) + ".pdf"])("sanitizes Drive filenames safely: %s", async (name) => {
  const run = await tools();
  google(metadata("application/pdf", name), new Response("file"));
  const result = await run.execute("download_file", { fileId: "file-1" }) as { path: string; name: string };
  expect(result.name).not.toMatch(/[\\/\u0000-\u001f:*?"<>|]/);
  expect(result.name.length).toBeLessThanOrEqual(180);
  expect(result.name).not.toBe(".");
  expect(await readFile(path.join(run.hostPath, path.basename(result.path)), "utf8")).toBe("file");
});
it("creates an original-format copy from this conversation only when writes are enabled", async () => {
  const readonly = await tools();
  expect(readonly.names).not.toContain("googleDrive_save_file");
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, "edited.docx"), new Uint8Array([80, 75, 0, 255]));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.pathname).toBe("/upload/drive/v3/files");
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(init.method).toBe("POST");
    const body = Buffer.from(await new Response(init.body).arrayBuffer());
    expect(body.includes(Buffer.from([80, 75, 0, 255]))).toBe(true);
    expect(body.toString()).toContain('"name":"Blank.docx"');
    expect(body.toString()).toContain('"parents":["folder-1"]');
    expect(body.toString()).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return Response.json({ id: "new-docx", name: "Blank.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", webViewLink: "https://drive.google.com/file/d/new-docx/view" });
  }));
  await expect(run.execute("save_file", { path: "/workspace/files/edited.docx", name: "Blank.docx", parentId: "folder-1" })).resolves.toEqual({ fileId: "new-docx", name: "Blank.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", webViewLink: "https://drive.google.com/file/d/new-docx/view" });
});
it.each(["absolute", "traversal", "symlink", "other-conversation"])("rejects saving %s paths outside this conversation before contacting Drive", async (kind) => {
  const run = await tools(true);
  const other = await tools(true);
  await writeFile(path.join(other.hostPath, "private.docx"), "private");
  await symlink(path.join(other.hostPath, "private.docx"), path.join(run.hostPath, "escape.docx"));
  const source = kind === "symlink" ? "/workspace/files/escape.docx"
    : kind === "traversal" ? `/workspace/files/../${path.basename(other.hostPath)}/private.docx`
    : path.join(other.hostPath, "private.docx");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Must not contact Drive for an outside file"); }));
  await expect(run.execute("save_file", { path: source, name: "Copy.docx" })).rejects.toThrow(/outside.*conversation|conversation.*only/i);
  expect(await readFile(path.join(other.hostPath, "private.docx"), "utf8")).toBe("private");
});
it.each([
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["application/vnd.google-apps.document", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["application/vnd.google-apps.spreadsheet", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["application/vnd.google-apps.presentation", "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
])("updates %s in place, preserving its Drive format", async (targetMime, suffix, sourceMime) => {
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, `edited.${suffix}`), new Uint8Array([80, 75, 0, 255]));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    if (url.pathname.startsWith("/drive/v3/files/")) return metadata(targetMime, "Original");
    expect(init.method).toBe("PATCH");
    expect(url.pathname).toBe("/upload/drive/v3/files/file-1");
    const body = Buffer.from(await new Response(init.body).arrayBuffer()).toString();
    expect(body).toContain(`"mimeType":"${targetMime}"`);
    expect(body).toContain(`Content-Type: ${sourceMime}`);
    expect(body).not.toContain('"name"');
    return Response.json({ id: "file-1", name: "Original", mimeType: targetMime, webViewLink: "https://drive.google.com/file/d/file-1/view" });
  }));
  await expect(run.execute("save_file", { path: `/workspace/files/edited.${suffix}`, fileId: "file-1" })).resolves.toMatchObject({ fileId: "file-1", name: "Original", mimeType: targetMime });
});
it.each(["application/vnd.google-apps.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"])("rejects incompatible replacement content for %s", async (mime) => {
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, "wrong.pdf"), "%PDF");
  google(metadata(mime));
  await expect(run.execute("save_file", { path: "/workspace/files/wrong.pdf", fileId: "file-1" })).rejects.toThrow(/format|unsupported/i);
});
it.each(["cannotDownloadFile", "exportSizeLimitExceeded", "insufficientFilePermissions"])("keeps Google %s errors actionable instead of asking for OAuth reconnect", async (reason) => {
  const run = await tools();
  google(new Response(JSON.stringify({ error: { message: "File operation is restricted", errors: [{ reason }] } }), { status: 403 }));
  await expect(run.execute("download_file", { fileId: "file-1" })).rejects.toThrow(reason);
});
it("honors caller cancellation before saving without contacting Drive", async () => {
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, "edited.docx"), "local");
  const controller = new AbortController();
  controller.abort();
  google();
  await expect(run.execute("save_file", { path: "/workspace/files/edited.docx", name: "Copy.docx" }, { ...run.context, signal: controller.signal })).rejects.toThrow(/abort/i);
  expect(await readFile(path.join(run.hostPath, "edited.docx"), "utf8")).toBe("local");
});
it("cancels a save during a Google retry delay while other conversation work progresses", async () => {
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, "edited.docx"), "local");
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    started();
    return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
  }));
  const pending = run.execute("save_file", { path: "/workspace/files/edited.docx", name: "Copy.docx" }, { ...run.context, signal: controller.signal });
  await ready;
  expect(await readFile(path.join(run.hostPath, "edited.docx"), "utf8")).toBe("local");
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(await readFile(path.join(run.hostPath, "edited.docx"), "utf8")).toBe("local");
});

it("rejects FIFOs without waiting for a writer", async () => {
  const run = await tools(true);
  await promisify(execFile)("mkfifo", [path.join(run.hostPath, "pipe.docx")]);
  google();
  await expect(run.execute("save_file", { path: "/workspace/files/pipe.docx", name: "Copy.docx" })).rejects.toThrow(/regular file/i);
});

it("times out a stalled media stream, cleans it up, and permits the next download", async () => {
  const run = await tools();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
  let pulls = 0;
  google(metadata(), new Response(new ReadableStream({ pull(stream) {
    if (pulls++ === 0) stream.enqueue(new Uint8Array([1, 2, 3]));
    else return new Promise(() => {});
  } })));
  await expect(run.execute("download_file", { fileId: "file-1" })).rejects.toThrow(/timeout/i);
  expect(await readdir(run.hostPath)).toEqual([]);
  google(metadata(), new Response("recovered"));
  await expect(run.execute("download_file", { fileId: "file-1" })).resolves.toMatchObject({ bytes: 9 });
});

it("times out a hung Google upload without removing the edited local file", async () => {
  const run = await tools(true);
  await writeFile(path.join(run.hostPath, "edited.docx"), "local");
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })));
  await expect(run.execute("save_file", { path: "/workspace/files/edited.docx", name: "Copy.docx" })).rejects.toThrow(/timeout/i);
  expect(await readFile(path.join(run.hostPath, "edited.docx"), "utf8")).toBe("local");
  google(Response.json({ id: "recovered", name: "Copy.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  await expect(run.execute("save_file", { path: "/workspace/files/edited.docx", name: "Copy.docx" })).resolves.toMatchObject({ fileId: "recovered" });
});
it("rejects nested sources so a mutable parent cannot escape the conversation during save", async () => {
  const run = await tools(true);
  await mkdir(path.join(run.hostPath, "nested"));
  await writeFile(path.join(run.hostPath, "nested", "edited.docx"), "local");
  google(Response.json({ id: "unsafe", name: "Copy.docx", mimeType: "application/octet-stream" }));
  await expect(run.execute("save_file", { path: "/workspace/files/nested/edited.docx", name: "Copy.docx" })).rejects.toThrow(/directly|root/i);
});
