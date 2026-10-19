import { afterEach, expect, it, vi } from "vitest";
import extension from "../index.js";

afterEach(() => { vi.unstubAllGlobals(); });

it("requests Slides write access only for a write-enabled agent", async () => {
  const scopes: string[][] = [];
  for (const allowWrite of [false, true]) {
    const tools = await extension.getAgentTools({ id: "a", extensions: { googleDrive: { allowWrite } } }, {
      config: {}, resolveOAuth: async (_agent, requirement) => {
        scopes.push(requirement.scopes ?? []);
        return { connected: true, provider: "google", accessToken: "test", scopes: requirement.scopes ?? [] };
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: { emailAddress: "test@example.com" } })));
    await tools.find((tool) => tool.name === "googleDrive_validate")!.execute({});
    const captured = scopes.at(-1)!;
    expect(captured.includes("https://www.googleapis.com/auth/presentations")).toBe(allowWrite);
  }
});

it("keeps Google's actionable message even after a large error metadata field", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { details: "x".repeat(1000), message: "The slide object does not exist." } }, { status: 400 })));
  const tools = await extension.getAgentTools({ id: "a", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test", scopes: [] }),
  });
  await expect(tools.find((tool) => tool.name === "googleDrive_create_folder")!.execute({ name: "Decks" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("The slide object does not exist.") });
});

it("reports a scope refusal even when Google puts its message after large metadata", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { details: "x".repeat(1000), message: "Request had insufficient authentication scopes." } }, { status: 403 })));
  const tools = await extension.getAgentTools({ id: "a", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test", scopes: [] }),
  });
  await expect(tools.find((tool) => tool.name === "googleDrive_create_folder")!.execute({ name: "Decks" })).resolves.toMatchObject({ reason: "insufficient_scope", isError: true });
});

it("returns rate_limited after two short retries even when Google suggests a long wait", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("quota exhausted", { status: 429, headers: { "retry-after": "30" } })));
  const tools = await extension.getAgentTools({ id: "a", extensions: { googleDrive: { allowWrite: true } } }, {
    config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "test", scopes: [] }),
  });
  await expect(tools.find((tool) => tool.name === "googleDrive_slides_batch_update")!.execute({ presentationId: "deck-1", requests: [{ createSlide: {} }] })).resolves.toMatchObject({ reason: "rate_limited" });
  expect(fetch).toHaveBeenCalledTimes(3);
}, 35_000);
