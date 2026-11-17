import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";
import { afterEach, expect, test, vi } from "vitest";
import { createInterviewExtension } from "../index.js";

const directories: string[] = [];
const windows: JSDOM[] = [];
afterEach(async () => {
  windows.splice(0).forEach((dom) => dom.window.close());
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "interview-page-"));
  directories.push(dataDir);
  const agent = { id: "guide", extensions: { interview: {} } };
  const config = { extensions: { interview: {}, multiUser: { enabled: true } }, ui: { port: 3000 } };
  const runAgent = vi.fn(async () => ({ payloads: [{ text: "Continue with a pilot" }], meta: { sessionId: "session-main", durationMs: 1 } }));
  const extension = createInterviewExtension();
  await extension.start({
    getConfig: () => config, getDataDir: () => dataDir, getAgent: () => agent,
    pageRoutePrefix: "/x/interview", supportsFrameViews: true,
    canUserAccessAgent: async () => true, runAgent, deleteSession: vi.fn(),
    getDeliverySink: () => undefined, logger: { error: vi.fn(), warn: vi.fn() },
  });
  const app = new Hono();
  let viewer: unknown = { user: { id: "owner" } };
  app.use("*", async (c, next) => { c.set("multiUserAuthContext", viewer); await next(); });
  const routes = new Hono();
  extension.registerPageRoutes(routes);
  app.route("/x/interview", routes);
  const context = { config, sessionId: "session-main", userId: "owner" };
  const tools = await extension.getAgentTools(agent, context);
  const opened = await tools.find((tool) => tool.name === "interview_ask")!.execute({
    title: "Release decisions", summary: "Choose a **reversible** rollout.",
    questions: [
      { id: "context", type: "info", question: "## Read this first\n<script>window.injected = true</script><img src=x onerror=\"window.injected = true\">A small release limits disruption." },
      { id: "release", type: "single", question: "How should we release?", options: [{ label: "Pilot", description: "A small first group" }, { label: "Everyone" }], recommended: "Pilot", context: "We can learn before expanding." },
      { id: "signals", type: "multi", question: "Which signals matter?", options: [{ label: "Adoption" }, { label: "Errors" }], recommended: ["Adoption", "Errors"] },
      { id: "reason", type: "text", question: "What matters most?" },
    ],
  }, context);
  const url = opened.link!;
  async function open() {
    const response = await app.request(new URL(url).pathname);
    const dom = new JSDOM(await response.text(), {
      url, runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "marked", { value: marked });
        Object.defineProperty(window, "DOMPurify", { value: createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]) });
        Object.defineProperty(window, "AbortController", { value: AbortController });
        Object.defineProperty(window, "fetch", { value: (input: string, init: RequestInit) => app.request(new URL(input, url).pathname, init) });
      },
    });
    windows.push(dom);
    return dom;
  }
  return { open, runAgent, impersonate: () => { viewer = { user: { id: "owner" }, impersonator: { id: "staff" } }; } };
}

test("owner reads sanitized context and answers single, multi and text questions", async () => {
  const h = await setup();
  const dom = await h.open();
  const document = dom.window.document;
  expect(document.querySelector("h1")?.textContent).toBe("Release decisions");
  expect(document.querySelector("#summary strong")?.textContent).toBe("reversible");
  expect(document.body.textContent).toContain("A small release limits disruption.");
  expect((dom.window as unknown as { injected?: boolean }).injected).toBeUndefined();
  expect(document.querySelector(".info script")).toBeNull();
  expect(document.querySelector(".info img")?.hasAttribute("onerror")).toBe(false);
  const pilot = document.querySelector<HTMLInputElement>('input[type="radio"][value="Pilot"]')!;
  pilot.click();
  expect(pilot.checked).toBe(true);
  expect(pilot.closest(".option")?.textContent).toContain("Recommended");
  const signals = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((input) => ["Adoption", "Errors"].includes(input.value));
  signals.forEach((input) => input.click());
  expect(signals.map((input) => input.checked)).toEqual([true, true]);
  const reason = document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')!;
  expect(reason).not.toBeNull();
  expect(document.querySelector(`label[for="${reason.id}"]`)?.textContent).toBe("Your answer");
});

test("Save draft retains chosen options, Other, notes and free text when reopened", async () => {
  const h = await setup();
  const dom = await h.open();
  const document = dom.window.document;
  document.querySelector<HTMLInputElement>('[data-question="release"] input[value="Pilot"]')!.click();
  const noteToggle = document.querySelector<HTMLButtonElement>('button[data-note-toggle="release"]');
  expect(noteToggle).not.toBeNull();
  noteToggle!.click();
  const note = document.querySelector<HTMLTextAreaElement>('textarea[data-note="release"]')!;
  note.value = "Measure adoption";
  note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  document.querySelector<HTMLInputElement>('[data-question="signals"] input[value="Adoption"]')!.click();
  document.querySelector<HTMLInputElement>('[data-question="signals"] input[value="__other__"]')!.click();
  const other = document.querySelector<HTMLInputElement>('input[data-other="signals"]')!;
  other.value = "Latency";
  other.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const reason = document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')!;
  reason.value = "Keep rollout reversible";
  reason.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  document.querySelector<HTMLButtonElement>("#save-draft")!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Draft saved"));
  const reopened = (await h.open()).window.document;
  expect(reopened.querySelector<HTMLInputElement>('[data-question="release"] input[value="Pilot"]')?.checked).toBe(true);
  expect(reopened.querySelector<HTMLTextAreaElement>('textarea[data-note="release"]')?.value).toBe("Measure adoption");
  expect(reopened.querySelector<HTMLInputElement>('[data-question="signals"] input[value="Adoption"]')?.checked).toBe(true);
  expect(reopened.querySelector<HTMLInputElement>('[data-question="signals"] input[value="__other__"]')?.checked).toBe(true);
  expect(reopened.querySelector<HTMLInputElement>('input[data-other="signals"]')?.value).toBe("Latency");
  expect(reopened.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.value).toBe("Keep rollout reversible");
});

test("Submit locks the stored answers, including in an older tab, without waking twice", async () => {
  const h = await setup();
  const dom = await h.open();
  const oldTab = await h.open();
  const document = dom.window.document;
  document.querySelector<HTMLInputElement>('[data-question="release"] input[value="Pilot"]')!.click();
  document.querySelector<HTMLInputElement>('[data-question="signals"] input[value="Errors"]')!.click();
  const reason = document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')!;
  reason.value = "Keep rollout reversible";
  reason.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const submit = document.querySelector<HTMLButtonElement>("#submit");
  expect(submit).not.toBeNull();
  submit!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Submitted. Your answers are locked."));
  expect(document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.disabled).toBe(true);
  oldTab.window.document.querySelector<HTMLButtonElement>("#submit")!.click();
  await vi.waitFor(() => expect(oldTab.window.document.querySelector('[role="status"]')?.textContent).toBe("Submitted. Your answers are locked."));
  const reopened = (await h.open()).window.document;
  expect(reopened.querySelector<HTMLInputElement>('[data-question="release"] input[value="Pilot"]')?.checked).toBe(true);
  expect(reopened.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.value).toBe("Keep rollout reversible");
  expect(reopened.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.disabled).toBe(true);
  expect(oldTab.window.document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.value).toBe("Keep rollout reversible");
  expect(h.runAgent).toHaveBeenCalledOnce();
});

test("Ask, Generate more and Review options stay inline and a generated option can be saved", async () => {
  const h = await setup();
  const dom = await h.open();
  const document = dom.window.document;
  const optionAsk = document.querySelector<HTMLButtonElement>('button[data-ask-option="Pilot"]');
  expect(optionAsk).not.toBeNull();
  h.runAgent.mockResolvedValueOnce({ payloads: [{ text: "The pilot keeps the release reversible." }], meta: { sessionId: "assist-one", durationMs: 1 } });
  optionAsk!.click();
  const prompt = document.querySelector<HTMLTextAreaElement>('textarea[data-ask="release"]')!;
  prompt.value = "Why is the small group safer?";
  document.querySelector<HTMLButtonElement>('button[data-send-ask="release"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-assist-result="release"]')?.textContent).toContain("The pilot keeps the release reversible."));
  h.runAgent.mockResolvedValueOnce({ payloads: [{ text: '{"options":[{"label":"Staged","description":"Expand in phases"}]}' }], meta: { sessionId: "assist-two", durationMs: 1 } });
  document.querySelector<HTMLButtonElement>('button[data-assist="generate"][data-question="release"]')!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button[data-add-option="Staged"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('button[data-add-option="Staged"]')!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-question="release"] input[value="Staged"]')).not.toBeNull());
  h.runAgent.mockResolvedValueOnce({ payloads: [{ text: '{"text":"A pilot reduces risk."}' }], meta: { sessionId: "assist-three", durationMs: 1 } });
  document.querySelector<HTMLButtonElement>('button[data-assist="review"][data-question="release"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-assist-result="release"]')?.textContent).toContain("A pilot reduces risk."));
  const reopened = (await h.open()).window.document;
  expect(reopened.querySelector<HTMLInputElement>('[data-question="release"] input[value="Staged"]')).not.toBeNull();
  expect(h.runAgent).toHaveBeenCalledTimes(3);
});

test("keyboard shortcuts navigate questions, choose Other, edit notes, save and submit", async () => {
  const h = await setup();
  const dom = await h.open();
  const document = dom.window.document;
  const press = (key: string, init: KeyboardEventInit = {}) => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  const release = document.querySelector<HTMLElement>('section[data-question="release"]')!;
  release.focus();
  press("2");
  expect(release.querySelector<HTMLInputElement>('input[value="Everyone"]')?.checked).toBe(true);
  press("o");
  expect(document.activeElement).toBe(release.querySelector('input[data-other="release"]'));
  const other = document.activeElement as HTMLInputElement;
  other.value = "Staged";
  other.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  release.focus();
  press("j");
  expect((document.activeElement as HTMLElement).dataset.question).toBe("signals");
  press("1");
  expect(document.querySelector<HTMLInputElement>('[data-question="signals"] input[value="Adoption"]')?.checked).toBe(true);
  press("n");
  const note = document.querySelector<HTMLTextAreaElement>('textarea[data-note="signals"]')!;
  expect(document.activeElement).toBe(note);
  note.value = "Watch adoption";
  note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  press("s", { ctrlKey: true });
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Draft saved"));
  release.focus();
  press("?");
  expect(document.querySelector<HTMLDetailsElement>("#shortcuts")?.open).toBe(true);
  expect(document.querySelector("#shortcuts")?.textContent).toContain("Cmd/Ctrl+Enter");
  press("Enter", { ctrlKey: true });
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Submitted. Your answers are locked."));
  const reopened = (await h.open()).window.document;
  expect(reopened.querySelector<HTMLInputElement>('input[data-other="release"]')?.value).toBe("Staged");
  expect(reopened.querySelector<HTMLTextAreaElement>('textarea[data-note="signals"]')?.value).toBe("Watch adoption");
});

test("an assist timeout is inline and still allows the owner to save and submit", async () => {
  const h = await setup();
  const dom = await h.open();
  const document = dom.window.document;
  vi.useFakeTimers();
  h.runAgent.mockImplementationOnce(() => new Promise(() => {}));
  document.querySelector<HTMLButtonElement>('button[data-assist="generate"][data-question="release"]')!.click();
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(90_001);
  await vi.waitFor(() => expect(document.querySelector('[data-assist-result="release"]')?.textContent).toContain("timed out"));
  vi.useRealTimers();
  const reason = document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')!;
  reason.value = "Keep rollout reversible after the timeout";
  reason.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  document.querySelector<HTMLButtonElement>("#save-draft")!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Draft saved"));
  document.querySelector<HTMLButtonElement>("#submit")!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Submitted. Your answers are locked."));
  expect((await h.open()).window.document.querySelector<HTMLTextAreaElement>('textarea[data-question="reason"]')?.value).toBe("Keep rollout reversible after the timeout");
});

test("an impersonating viewer sees answers with all editing and assist controls disabled", async () => {
  const h = await setup();
  h.impersonate();
  const document = (await h.open()).window.document;
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Read-only while viewing as another user.");
  expect([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].every((input) => input.disabled)).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("#submit")?.hidden).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("#save-draft")?.hidden).toBe(true);
  expect(h.runAgent).not.toHaveBeenCalled();
});
