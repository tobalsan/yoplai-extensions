import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Form } from "./model.js";

/** Synchronous replacement keeps submit's read/change/write indivisible within the gateway. */
export class FormStore {
  constructor(private readonly root: string) {}
  private file(agentId: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid form identifier");
    return path.join(this.root, "interview", encodeURIComponent(agentId).replace(/\./g, "%2E"), `${id}.json`);
  }
  get(agentId: string, id: string): Form | undefined {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
    try { return JSON.parse(fs.readFileSync(this.file(agentId, id), "utf8")) as Form; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  put(form: Form) {
    const file = this.file(form.agentId, form.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(form), { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  pendingWakes(): Form[] {
    const root = path.join(this.root, "interview");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) =>
      fs.readdirSync(path.join(root, entry.name)).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(root, entry.name, file), "utf8")) as Form)
    ).filter((form) => form.state === "submitted" && form.wake === "pending");
  }
}
