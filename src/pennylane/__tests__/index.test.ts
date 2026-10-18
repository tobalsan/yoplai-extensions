import { describe, expect, it } from "vitest";

import extension from "../index.js";

describe("pennylane extension", () => {
  it("keeps pagination, deduplication, and draft safety guidance without a tool catalog", async () => {
    const prompts = await extension.getSystemPromptContributions(
      { id: "a1", extensions: { pennylane: { apiToken: "test-token" } } },
      { config: { extensions: {} } }
    );
    const prompt = prompts!.join("\n");
    expect(prompt).not.toContain("Available tools:");
    expect(prompt).not.toMatch(/^- pennylane_\w+.*:/m);
    expect(prompt).toContain("money values are decimal strings");
    expect(prompt).toContain("cursor pagination is walked transparently");
    expect(prompt).toContain("refusing to touch a finalized invoice");
    expect(prompt).toContain("before creating, look up by external_reference");
    expect(prompt).toContain("NO quote accept/status/send tool");
    expect(prompt).toContain("retries on 429");
  });
});
