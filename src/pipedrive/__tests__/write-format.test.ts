import { describe, expect, it } from "vitest";

import {
  expectedNoteBody,
  formatValue,
  renderActivityNote,
  renderNote,
  renderTrace,
  storedNoteBody,
  stripAgentMarkers,
} from "../write-format.js";

describe("write-format", () => {
  it("renders one marker and escapes HTML in requester and content", () => {
    const html = renderNote("Éric <b>&", "Call <script>alert(1)</script>\nsecond & line");
    expect(html).toBe("<p>[Agent-made for Éric &lt;b&gt;&amp;]</p><p>Call &lt;script&gt;alert(1)&lt;/script&gt;<br>second &amp; line</p>");
    expect(html.match(/\[Agent-made for/g)).toHaveLength(1);
  });

  it("compares stored notes and traces ignoring the marker wrapper", () => {
    const content = "Updated by agent for Éric: Owner Alice → Bob";
    expect(storedNoteBody(renderNote("Éric", content))).toBe(expectedNoteBody(content));
    expect(storedNoteBody(renderTrace(content))).toBe(expectedNoteBody(content));
  });

  it("compares requested plaintext, normalised as Pipedrive stores it, with the stored HTML as-is", () => {
    const content = "a & b <i> \"q\" 's'   spaced";
    expect(storedNoteBody("<p>[Agent-made for Éric]</p><p>a & b &lt;i&gt; \"q\" 's' spaced</p>")).toBe(expectedNoteBody(content));
  });

  it("never decodes both sides: literal entity text differs from the quote it spells", () => {
    expect(expectedNoteBody("&quot;")).toBe("&quot;");
    expect(expectedNoteBody("&quot;")).not.toBe(storedNoteBody("<p>\"</p>"));
    expect(expectedNoteBody('"')).not.toBe(storedNoteBody("<p>&quot;</p>"));
    expect(expectedNoteBody("&#39;")).not.toBe(storedNoteBody("<p>'</p>"));
    expect(storedNoteBody("<p>&quot;</p>")).toBe("&quot;");
    expect(storedNoteBody("<p>&amp;quot;</p>")).toBe("&amp;quot;");
  });

  it("keeps existing activity note content and exactly one marker", () => {
    const existing = renderActivityNote("Sam", "<p>Human note</p>", "first update");
    const stripped = stripAgentMarkers(existing);
    expect(stripped.startsWith("<p>Human note</p>")).toBe(true);
    const rewritten = renderActivityNote("Éric", stripped, "second update");
    expect(rewritten.match(/\[Agent-made for/g)).toHaveLength(1);
    expect(rewritten).toContain("<p>Human note</p>");
    expect(rewritten).toContain("first update");
    expect(rewritten).toContain("second update");
  });

  it("formats values compactly", () => {
    expect(formatValue(null)).toBe("empty");
    expect(formatValue([])).toBe("empty");
    expect(formatValue({ amount: 5, currency: "EUR" })).toBe("5 EUR");
    expect(formatValue({ from: "a", until: "b" })).toBe("a – b");
    expect(formatValue(["x", "y"])).toBe("x, y");
  });
});
