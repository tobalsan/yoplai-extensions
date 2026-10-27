import { open, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ToolExecutionContext } from "./tool-extension.js";

class ConversationFileError extends Error {
  constructor(message: string, readonly status: 400 | 413) { super(message); }
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function openConversationFile(local: string, folder: string) {
  if (process.platform !== "linux" && path.dirname(local) !== folder) throw new ConversationFileError("Save files directly in the conversation folder root; nested paths are not supported on this platform.", 400);
  const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (process.platform === "linux") {
      // readlink reports the opened file's kernel path without walking mutable parents again.
      const openedPath = await readlink(`/proc/self/fd/${file.fd}`);
      if (openedPath.endsWith(" (deleted)") || !inside(folder, openedPath)) throw new ConversationFileError("File path is outside the current conversation folder or was deleted during opening.", 400);
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readConversationFile(sourcePath: string, context: ToolExecutionContext | undefined, signal: AbortSignal, maxBytes?: number) {
  if (!context?.conversationFiles) throw new Error("A conversation files folder is required to read local files.");
  signal.throwIfAborted();
  const originalPath = sourcePath;
  try {
    const folder = await realpath(context.conversationFiles.hostPath);
    const { hostPath, runtimePath } = context.conversationFiles;
    if (!path.isAbsolute(sourcePath)) sourcePath = path.resolve(runtimePath, sourcePath);
    let local: string;
    if (inside(runtimePath, sourcePath)) local = path.resolve(folder, path.relative(runtimePath, sourcePath));
    else if (inside(hostPath, sourcePath)) local = path.resolve(folder, path.relative(hostPath, sourcePath));
    else if (inside(folder, sourcePath)) local = path.resolve(sourcePath);
    else throw new ConversationFileError("File path is outside the current conversation folder.", 400);
    if (process.platform !== "linux" && path.dirname(local) !== folder) throw new ConversationFileError("Save files directly in the conversation folder root; nested paths are not supported on this platform.", 400);
    local = await realpath(local);
    if (!inside(folder, local)) throw new ConversationFileError("File path is outside the current conversation folder.", 400);
    const file = await openConversationFile(local, folder);
    let bytes: Buffer;
    try {
      if (!(await file.stat()).isFile()) throw new ConversationFileError("Only regular files inside the current conversation folder may be read.", 400);
      if (maxBytes !== undefined && (await file.stat()).size > maxBytes) throw new ConversationFileError(`File exceeds the ${maxBytes} byte limit.`, 413);
      if (maxBytes === undefined) bytes = await file.readFile({ signal });
      else {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
          length += chunk.length;
          if (length > maxBytes) throw new ConversationFileError(`File exceeds the ${maxBytes} byte limit.`, 413);
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
    } finally { await file.close(); }
    return bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new ConversationFileError(`File or conversation folder does not exist for path: ${originalPath}.`, 400);
    if (error instanceof Error && "code" in error && error.code === "ELOOP") throw new ConversationFileError(`File path cannot be opened without following a symlink: ${originalPath}.`, 400);
    throw error;
  }
}

