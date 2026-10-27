import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import extension from "../index.js";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function mount() {
  const hostPath = await mkdtemp(path.join(os.tmpdir(), "zendesk-upload-"));
  folders.push(hostPath);
  const tools = await extension.getAgentTools({ id: "a", extensions: { zendesk: { mode: "api_key", subdomain: "acme", email: "a@b.co", apiKey: "k" } } }, { config: {} });
  return { tool: tools.find((tool) => tool.name === "zendesk_upload_article_attachment")!, context: { conversationFiles: { hostPath, runtimePath: "/workspace/files" } }, hostPath };
}

it("uploads a conversation image and returns compact attachment details and an escaped img snippet", async () => {
  const run = await mount();
  await writeFile(path.join(run.hostPath, "diagram.png"), new Uint8Array([137, 80, 0, 255]));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ article_attachment: {
    id: 19, content_url: "https://acme.zendesk.com/hc/article_attachments/19?a=1&b=\"<>'", file_name: "Diagram & \"<>' .png", size: 4, inline: true,
  } }, { status: 201 }));
  expect(await run.tool.execute({ articleId: 7, path: "/workspace/files/diagram.png" }, run.context)).toEqual({
    attachment: { id: 19, contentUrl: "https://acme.zendesk.com/hc/article_attachments/19?a=1&b=\"<>'", fileName: "Diagram & \"<>' .png", size: 4 },
    imgSnippet: '<img src="https://acme.zendesk.com/hc/article_attachments/19?a=1&amp;b=&quot;&lt;&gt;&#39;" alt="Diagram &amp; &quot;&lt;&gt;&#39; .png">',
  });
  const form = fetchSpy.mock.calls[0]?.[1]?.body as FormData;
  expect(form.get("inline")).toBe("true");
  expect((form.get("file") as File).name).toBe("diagram.png");
  expect(run.tool.outputSchema).toHaveProperty("type", "object");
});

it("refuses images over 5 MB before contacting Zendesk", async () => {
  const run = await mount();
  await writeFile(path.join(run.hostPath, "large.png"), new Uint8Array(5 * 1024 * 1024 + 1));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
  await expect(run.tool.execute({ articleId: 7, path: "large.png" }, run.context)).rejects.toThrow(/5 MB/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each([
  ["diagram.PNG", "image/png"], ["screen.jpg", "image/jpeg"], ["screen.jpeg", "image/jpeg"], ["diagram.webp", "image/webp"], ["demo.gif", "image/gif"],
])("accepts %s by extension and uploads a plain attachment when inline is false", async (fileName, mimeType) => {
  const run = await mount();
  await writeFile(path.join(run.hostPath, fileName), new Uint8Array([1, 2, 3]));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ article_attachment: { id: 20, content_url: "https://example.test/20", file_name: fileName, size: 3 } }));
  await run.tool.execute({ articleId: 7, path: fileName, inline: false }, run.context);
  const form = fetchSpy.mock.calls[0]?.[1]?.body as FormData;
  expect(form.get("inline")).toBe("false");
  const file = form.get("file") as File;
  expect(file.name).toBe(fileName);
  expect(file.type).toBe(mimeType);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

it("accepts a host path within the current conversation", async () => {
  const run = await mount();
  const source = path.join(run.hostPath, "diagram.png");
  await writeFile(source, "image");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ article_attachment: { id: 20, content_url: "https://example.test/20", file_name: "diagram.png", size: 5 } }));
  await expect(run.tool.execute({ articleId: 7, path: source }, run.context)).resolves.toMatchObject({ attachment: { id: 20 } });
});

it.each(["drawing.svg", "notes.pdf", "image.txt"])("rejects unsupported %s before HTTP", async (source) => {
  const run = await mount();
  await writeFile(path.join(run.hostPath, source), "unsupported");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
  await expect(run.tool.execute({ articleId: 7, path: source }, run.context)).rejects.toThrow(/PNG, JPEG, WebP and GIF/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each(["outside path", "outside symlink"])("rejects an %s without HTTP", async (kind) => {
  const run = await mount();
  const outside = await mount();
  const source = path.join(outside.hostPath, "private.png");
  await writeFile(source, "private");
  if (kind === "outside symlink") await symlink(source, path.join(run.hostPath, "escape.png"));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
  await expect(run.tool.execute({ articleId: 7, path: kind === "outside symlink" ? "escape.png" : source }, run.context)).rejects.toThrow(/outside the current conversation folder/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("requires a current conversation files folder before HTTP", async () => {
  const run = await mount();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
  await expect(run.tool.execute({ articleId: 7, path: "diagram.png" }, {})).rejects.toThrow(/conversation files folder is required/);
  expect(fetchSpy).not.toHaveBeenCalled();
});
