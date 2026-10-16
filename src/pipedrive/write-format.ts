/** Rendering of agent markers, notes and trace text. All free text is HTML-escaped (text-node escaping: & < >) before it reaches Pipedrive. */

const MARKER_PARAGRAPH = /^<p>\[Agent-made for [^\]]*\]<\/p>/;

export const ACTIVITY_SUBJECT_PREFIX = "[Agent] ";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escaped paragraph body: line breaks become <br>. */
function escapedBody(text: string): string {
  return escapeHtml(text.trim()).replace(/\r?\n/g, "<br>");
}

export function agentMarker(requestedBy: string): string {
  return `<p>[Agent-made for ${escapeHtml(requestedBy)}]</p>`;
}

/** Note HTML for create_note: marker paragraph plus escaped content. */
export function renderNote(requestedBy: string, content: string): string {
  return `${agentMarker(requestedBy)}<p>${escapedBody(content)}</p>`;
}

/** Note HTML for an automatic trace: the trace text itself names the requester. */
export function renderTrace(text: string): string {
  return `<p>${escapedBody(text)}</p>`;
}

/** Whitespace runs collapse in the stored form (live sandbox); `<br>` and `&lt;` / `&gt;` are kept. */
function collapseWhitespace(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

/**
 * Body of a stored note exactly as Pipedrive returns it, ignoring only the agent marker, the `<p>` wrapper and
 * whitespace. Entities are NOT decoded: the stored HTML is already in Pipedrive's normalised form.
 */
export function storedNoteBody(html: string): string {
  const withoutMarker = html.trim().replace(MARKER_PARAGRAPH, "");
  const paragraph = /^<p>([\s\S]*)<\/p>$/.exec(withoutMarker);
  return collapseWhitespace(paragraph ? paragraph[1] : withoutMarker);
}

/**
 * Body Pipedrive will store for plaintext `content` sent the way this tool sends it (see escapedBody).
 * Live sandbox: it re-serialises `&amp;` to `&` (and `&quot;` / `&#39;` to `"` / `'`, which the tool never sends),
 * decoding once, so plaintext `&quot;` is sent as `&amp;quot;` and stored as `&quot;`, never as `"`.
 */
export function expectedNoteBody(content: string): string {
  return collapseWhitespace(escapedBody(content).replace(/&amp;/g, "&"));
}

/** Existing activity note with leading agent markers removed; the human content is kept verbatim. */
export function stripAgentMarkers(noteHtml: string): string {
  let rest = noteHtml.trim();
  while (MARKER_PARAGRAPH.test(rest)) rest = rest.replace(MARKER_PARAGRAPH, "").trimStart();
  return rest;
}

/** Activity note: single marker, then the human/agent body, then an optional visible update line. */
export function renderActivityNote(requestedBy: string, bodyHtml: string, updateLine?: string): string {
  return `${agentMarker(requestedBy)}${bodyHtml}${updateLine ? `<p>${escapedBody(updateLine)}</p>` : ""}`;
}

export function escapedParagraph(text: string): string {
  return `<p>${escapedBody(text)}</p>`;
}

/** Compact readable rendering of a value for diffs and traces. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.map(formatValue).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("amount" in record && "currency" in record) return `${String(record.amount)} ${String(record.currency)}`;
    if ("from" in record && "until" in record) return `${String(record.from)} – ${String(record.until)}`;
    if ("value" in record) return formatValue(record.value);
    return JSON.stringify(value);
  }
  return String(value);
}
