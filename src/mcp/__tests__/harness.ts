import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Handler = (context: any) => Promise<any>;

export function routeApp() {
  const routes = new Map<string, Handler>();
  return {
    routes,
    get(path: string, handler: Handler) { routes.set(`GET ${path}`, handler); },
    post(path: string, handler: Handler) { routes.set(`POST ${path}`, handler); },
  };
}

/** Route context where `scope` defaults to "team"; responses are `{ body, status }`. */
export function routeContext(query: Record<string, string>, identity: Record<string, unknown> = { user: { id: "user-a" } }) {
  return {
    get: () => identity,
    req: { query: (name: string) => name === "scope" ? (query[name] ?? "team") : query[name] },
    json: (body: unknown) => body,
    text: (body: string, status?: number) => ({ body, status }),
    html: (body: string, status?: number) => ({ body, status }),
    redirect: (url: string) => ({ redirect: url }),
  };
}

export function tempDirs() {
  const dirs: string[] = [];
  return {
    async make(prefix: string) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    async cleanup() { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); },
  };
}
