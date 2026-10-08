import { describe, expect, it } from "vitest";

import { labelFromServerInfo } from "../client-manager.js";

describe("labelFromServerInfo", () => {
  it("splits a sentence-like title into title and description", () => {
    expect(labelFromServerInfo({ name: "claap", title: "Claap Meeting Recording Platform: Browse meeting recordings, contacts, companies and deals." }))
      .toEqual({ title: "Claap Meeting Recording Platform", description: "Browse meeting recordings, contacts, companies and deals." });
  });

  it("keeps short titles and explicit descriptions, and ignores slug names", () => {
    expect(labelFromServerInfo({ name: "linear", title: "Linear", description: "Issues" })).toEqual({ title: "Linear", description: "Issues" });
    expect(labelFromServerInfo({ name: "github-mcp-server" })).toEqual({});
    expect(labelFromServerInfo({ title: "A very long title without any separator that goes on and on" })).toEqual({ description: "A very long title without any separator that goes on and on" });
  });
});
