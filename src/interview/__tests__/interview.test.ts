import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { createInterviewExtension, type InterviewHost } from "../index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const questions = [
  { id: "release", type: "single", question: "How should we release?", options: [{ label: "Pilot", description: "A small first group" }, { label: "Everyone" }], recommended: "Pilot" },
  { id: "reason", type: "text", question: "What matters most?" },
];
const answers = { release: { selected: ["Pilot"], note: "Measure adoption" }, reason: { text: "Keep rollout reversible" } };

async function setup(directory?: string) {
  const dataDir = directory ?? await fs.mkdtemp(path.join(os.tmpdir(), "interview-test-"));
  if (!directory) directories.push(dataDir);
  const agent = { id: "guide", extensions: { interview: {} } };
  const config = { extensions: { interview: {}, multiUser: { enabled: true } }, ui: { port: 3000 } };
  const runAgent = vi.fn<InterviewHost["runAgent"]>(async (_input) => ({ payloads: [{ text: "Continuing with the pilot" }], meta: { sessionId: "main-session" } }));
  const sink = vi.fn(async (_input: { text: string }) => {});
  const ctx = {
    getConfig: () => config, getDataDir: () => dataDir, getAgent: () => agent,
    pageRoutePrefix: "/x/interview", supportsFrameViews: true,
    canUserAccessAgent: vi.fn(async () => true), runAgent, deleteSession: vi.fn(), resetSession: vi.fn(async () => {}),
    getDeliverySink: () => sink, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const extension = createInterviewExtension();
  await extension.start(ctx);
  const app = new Hono();
  let viewer: unknown = { user: { id: "owner" } };
  app.use("*", async (c, next) => { c.set("multiUserAuthContext", viewer); await next(); });
  const routes = new Hono();
  extension.registerPageRoutes(routes);
  app.route("/x/interview", routes);
  const context = { agent, config, sessionId: "main-session", sessionOwnerId: null, userId: "owner", requesterId: "threadit:invented-user", origin: { sink: "threadit", destination: { channel: "42:7" } } };
  const tools = await extension.getAgentTools(agent, context);
  const ask = (input = { title: "Release decisions", summary: "We are choosing a reversible release for a new feature.", questions }) => tools.find((tool) => tool.name === "interview_ask")!.execute(input, context);
  const wait = (id: string, waitSeconds = 0) => tools.find((tool) => tool.name === "interview_wait")!.execute({ id, waitSeconds }, context);
  return { dataDir, ctx, extension, app, ask, wait, runAgent, sink, context, config, agent, tools, viewer: (value: unknown) => { viewer = value; } };
}

test("ask immediately provides a form link, then a late submit resumes the same session with all answers", async () => {
  const h = await setup();
  const opened = await h.ask();
  expect(opened).toMatchObject({ status: "open", link: expect.stringMatching(/^http:\/\/localhost:3000\/x\/interview\/guide\//) });
  expect(h.runAgent).not.toHaveBeenCalled();
  expect(await h.wait(opened.id)).toEqual({ status: "pending", id: opened.id, link: opened.link });
  const page = await h.app.request(new URL(opened.link).pathname);
  expect(page.status).toBe(200);
  const html = await page.text();
  const token = JSON.parse(html.match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  h.viewer(null);
  const submitted = await h.app.request(`${new URL(opened.link).pathname}/submit`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, answers }) });
  expect(submitted.status).toBe(200);
  expect(submitted.headers.get("access-control-allow-origin")).toBe("*");
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  expect(h.runAgent.mock.calls[0][0]).toMatchObject({ sessionId: "main-session", sessionOwnerId: null, userId: "owner", requesterId: "threadit:invented-user", origin: h.context.origin });
  expect(h.runAgent.mock.calls[0][0].message).toContain("Keep rollout reversible");
  expect(h.runAgent.mock.calls[0][0].message).toContain(opened.id);
  await vi.waitFor(() => expect(h.sink).toHaveBeenCalledTimes(2));
  expect(h.sink.mock.calls[0][0].text).toContain("Release decisions");
  expect(h.sink.mock.calls[0][0].text).toContain("Pilot");
  expect(h.sink.mock.calls[1][0].text).toBe("Continuing with the pilot");
});

test("submit during a live wait returns all answers without starting a second turn", async () => {
  const h = await setup();
  const opened = await h.ask();
  let settled = false;
  const waiting = h.wait(opened.id, 30).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  const page = await h.app.request(new URL(opened.link).pathname);
  const html = await page.text();
  const token = JSON.parse(html.match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const result = await h.app.request(`${new URL(opened.link).pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) });
  expect(result.status).toBe(200);
  expect(await waiting).toEqual({ status: "answered", id: opened.id, answers });
  expect(h.runAgent).not.toHaveBeenCalled();
  expect(h.sink).toHaveBeenCalledOnce();
});

test("submitting twice preserves the first answers and wakes once", async () => {
  const h = await setup();
  const opened = await h.ask();
  const html = await (await h.app.request(new URL(opened.link).pathname)).text();
  const token = JSON.parse(html.match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const submit = (value: unknown) => h.app.request(`${new URL(opened.link).pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers: value }) });
  const results = await Promise.all([submit(answers), submit({ reason: { text: "Overwrite" } })]);
  expect(results.map((result) => result.status)).toEqual([200, 409]);
  expect(await results[1].json()).toMatchObject({ answers });
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  expect(await h.wait(opened.id)).toEqual({ status: "answered", id: opened.id, answers });
});

test("pending forms and failed wakes survive a restart", async () => {
  const h = await setup();
  const opened = await h.ask();
  const restarted = await setup(h.dataDir);
  const page = await restarted.app.request(new URL(opened.link).pathname);
  expect(page.status).toBe(200);
  const token = JSON.parse((await page.text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  restarted.runAgent.mockRejectedValueOnce(new Error("Temporary gateway failure"));
  expect((await restarted.app.request(`${new URL(opened.link).pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
  await vi.waitFor(() => expect(restarted.ctx.logger.error).toHaveBeenCalled());
  const recovered = await setup(h.dataDir);
  await vi.waitFor(() => expect(recovered.runAgent).toHaveBeenCalledOnce());
  expect(recovered.runAgent.mock.calls[0][0]).toMatchObject({ sessionId: "main-session" });
  expect(recovered.runAgent.mock.calls[0][0].message).toContain("Keep rollout reversible");
  await vi.waitFor(() => expect(recovered.sink).toHaveBeenCalledTimes(2));
  const next = await setup(h.dataDir);
  expect(next.runAgent).not.toHaveBeenCalled();
});

test("only the owner can load a form; cookie-free tokens expire, stay form-bound and recheck access", async () => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const getToken = async (url: string) => JSON.parse((await (await h.app.request(url)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const token = await getToken(pathname);
  h.viewer({ user: { id: "stranger" } });
  expect((await h.app.request(pathname)).status).toBe(404);
  h.viewer(null);
  expect((await h.app.request(pathname)).status).toBe(404);
  const load = (value: unknown, url = pathname) => h.app.request(`${url}/load`, { method: "POST", body: JSON.stringify({ token: value }) });
  expect((await load(token)).status).toBe(200);
  expect((await load(`${token}changed`)).status).toBe(401);
  const second = await h.ask();
  expect((await load(token, new URL(second.link).pathname)).status).toBe(401);
  h.ctx.canUserAccessAgent.mockResolvedValueOnce(false);
  expect((await load(token)).status).toBe(403);
  h.viewer({ user: { id: "owner" }, impersonator: { id: "staff" } });
  expect(await getToken(pathname)).toBeUndefined();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 9 * 60 * 60 * 1000);
  try { expect((await load(token)).status).toBe(401); } finally { now.mockRestore(); }
});

test("drafts retain answers and a human-added option across reload, then lock on submit", async () => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const post = (operation: string, value: Record<string, unknown> = {}) => h.app.request(`${pathname}/${operation}`, { method: "POST", body: JSON.stringify({ token, ...value }) });
  const saved = await post("draft", { answers, addOption: { questionId: "release", option: { label: "Private preview", description: "Invitation only" } } });
  expect(saved.status).toBe(200);
  const loaded = await (await post("load")).json();
  expect(loaded.form.draft).toEqual(answers);
  expect(loaded.form.questions[0].options).toContainEqual({ label: "Private preview", description: "Invitation only" });
  expect((await post("submit", { answers })).status).toBe(200);
  expect((await post("draft", { answers: {} })).status).toBe(409);
  expect((await (await post("load")).json()).form).toMatchObject({ state: "submitted", answers });
});

test.each(["ask", "generate", "review"])("%s assist uses an isolated one-shot session with context and deletes it", async (action) => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const post = (op: string, value: Record<string, unknown>) => h.app.request(`${pathname}/${op}`, { method: "POST", body: JSON.stringify({ token, ...value }) });
  await post("draft", { answers: { reason: { text: "PRIVATE DRAFT" } } });
  h.runAgent.mockResolvedValueOnce({ payloads: [{ text: action === "generate" ? '{"options":[{"label":"Private preview","description":"Invitation only"}]}' : "A pilot reduces risk." }], meta: { sessionId: "assist-session" } });
  const response = await post("assist", { action, questionId: "release", option: "Pilot", prompt: "Why this recommendation?" });
  expect(response.status).toBe(200);
  const result = await response.json();
  if (action === "generate") expect(result.options).toEqual([{ label: "Private preview", description: "Invitation only" }]);
  else expect(result.text).toBe("A pilot reduces risk.");
  expect(h.runAgent).toHaveBeenCalledOnce();
  const request = h.runAgent.mock.calls[0][0];
  expect(request).toMatchObject({ agentId: "guide", sessionKey: expect.stringMatching(/^interview-assist:/), background: true, source: "interview", userId: "owner" });
  expect(request.sessionId).not.toBe("main-session");
  expect(request.message).toContain("We are choosing a reversible release for a new feature.");
  expect(request.message).toContain("What matters most?");
  expect(request.message).toContain("Why this recommendation?");
  expect(request.message).not.toContain("PRIVATE DRAFT");
  expect(h.ctx.deleteSession).toHaveBeenCalledWith("guide", "assist-session");
  expect(h.ctx.resetSession).toHaveBeenCalledWith("guide", "assist-session", "owner");
  expect(await h.wait(opened.id)).toMatchObject({ status: "pending" });
});

test("web forms declare their own panel frame and older panel hosts retain the link", async () => {
  const h = await setup();
  const ask = h.tools.find((tool) => tool.name === "interview_ask")!;
  const input = { title: "Web interview", summary: "Choose a release.", questions };
  const context = { ...h.context, origin: undefined };
  const opened = await ask.execute(input, context);
  expect(opened).toMatchObject({ frameView: { url: new URL(opened.link!).pathname, title: "Web interview", key: opened.id } });
  h.ctx.supportsFrameViews = false;
  const fallback = await ask.execute(input, context);
  expect(fallback).toHaveProperty("link");
  expect(fallback).not.toHaveProperty("frameView");
  expect(await h.ask()).not.toHaveProperty("frameView");
});

test("two forms in the same session keep answers and wake identities separate", async () => {
  const h = await setup();
  const first = await h.ask();
  const second = await h.ask({ title: "Second decision", summary: "Choose another release.", questions });
  expect(first.link).not.toBe(second.link);
  for (const [opened, text] of [[first, "First form only"], [second, "Second form only"]] as const) {
    const pathname = new URL(opened.link).pathname;
    const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
    expect((await h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers: { reason: { text } } }) })).status).toBe(200);
  }
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledTimes(2));
  expect(h.runAgent.mock.calls[0][0].message).toContain(first.id);
  expect(h.runAgent.mock.calls[0][0].message).toContain("First form only");
  expect(h.runAgent.mock.calls[0][0].message).not.toContain("Second form only");
  expect(h.runAgent.mock.calls[1][0].message).toContain(second.id);
  expect(h.runAgent.mock.calls[1][0].message).not.toContain("First form only");
});

test("missing gateway identity refuses multi-user ask while single-user forms belong to local", async () => {
  const h = await setup();
  const ask = h.tools.find((tool) => tool.name === "interview_ask")!;
  const input = { title: "Local decisions", summary: "Choose a release.", questions };
  const context = { ...h.context, userId: undefined };
  await expect(ask.execute(input, context)).rejects.toThrow("link their account");
  h.config.extensions.multiUser.enabled = false;
  const opened = await ask.execute(input, context);
  h.viewer(null);
  const pathname = new URL(opened.link).pathname;
  const page = await h.app.request(pathname);
  expect(page.status).toBe(200);
  const token = JSON.parse((await page.text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  expect((await h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  expect(h.runAgent.mock.calls[0][0].userId).toBeUndefined();
});

test("assist hangs time out, reject overlapping requests and leave the main form usable", async () => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const assist = () => h.app.request(`${pathname}/assist`, { method: "POST", body: JSON.stringify({ token, action: "ask", questionId: "release", prompt: "Explain" }) });
  vi.useFakeTimers();
  try {
    h.runAgent.mockImplementationOnce(() => new Promise(() => {}));
    const pending = assist();
    await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
    const signal = h.runAgent.mock.calls[0][0].signal!;
    expect((await assist()).status).toBe(409);
    await vi.advanceTimersByTimeAsync(90_000);
    const response = await pending;
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("timed out");
    expect(signal.aborted).toBe(true);
    expect(h.ctx.deleteSession).toHaveBeenCalled();
    expect((await assist()).status).toBe(200);
    const waiting = h.wait(opened.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toMatchObject({ status: "pending" });
  } finally { vi.useRealTimers(); }
});

test("oversized forms and invalid or oversized answers are rejected before submission", async () => {
  const h = await setup();
  await expect(h.ask({ title: "Too large", summary: "x".repeat(256 * 1024), questions })).rejects.toThrow("256 KB");
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const submit = (value: unknown) => h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers: value }) });
  expect((await submit({ reason: { text: "x".repeat(256 * 1024) } })).status).toBe(400);
  expect((await submit({ release: { selected: ["Pilot", "Everyone"] } })).status).toBe(400);
  expect((await submit({ release: { selected: ["Invented choice"] } })).status).toBe(400);
  expect((await submit({ unknown: { text: "Unknown question" } })).status).toBe(400);
  expect(h.runAgent).not.toHaveBeenCalled();
  expect((await submit(answers)).status).toBe(200);
});

test("wait stays within 270 seconds, reports progress and rejects cancellation without losing wake", async () => {
  const h = await setup();
  const opened = await h.ask();
  const wait = h.tools.find((tool) => tool.name === "interview_wait")!;
  vi.useFakeTimers();
  try {
    const emitProgress = vi.fn();
    let settled = false;
    const capped = wait.execute({ id: opened.id, waitSeconds: 1000 }, { ...h.context, emitProgress }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(269_000);
    expect(settled).toBe(false);
    expect(emitProgress).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await capped).toMatchObject({ status: "pending" });
    const controller = new AbortController();
    const aborted = wait.execute({ id: opened.id }, { ...h.context, signal: controller.signal });
    const rejected = expect(aborted).rejects.toThrow("Cancelled by test");
    controller.abort(new Error("Cancelled by test"));
    await rejected;
  } finally { vi.useRealTimers(); }
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  expect((await h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
});

test("a different user or session cannot wait for another interview's answers", async () => {
  const h = await setup();
  const opened = await h.ask();
  const wait = h.tools.find((tool) => tool.name === "interview_wait")!;
  await expect(wait.execute({ id: opened.id, waitSeconds: 0 }, { ...h.context, userId: "stranger" })).rejects.toThrow("Form not found");
  await expect(wait.execute({ id: opened.id, waitSeconds: 0 }, { ...h.context, sessionId: "other-session" })).rejects.toThrow("Form not found");
});

test("a hanging recap sink cannot prevent the same session from waking", async () => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  h.sink.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    expect((await h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.runAgent).toHaveBeenCalledOnce();
    expect(h.runAgent.mock.calls[0][0].sessionId).toBe("main-session");
  } finally { vi.useRealTimers(); }
});

test("adding an option cannot exceed the form limit or alter the saved definition on refusal", async () => {
  const h = await setup();
  const opened = await h.ask({ title: "Near limit", summary: "x".repeat(250 * 1024), questions });
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  const response = await h.app.request(`${pathname}/draft`, { method: "POST", body: JSON.stringify({ token, answers: {}, addOption: { questionId: "release", option: { label: "x".repeat(8 * 1024) } } }) });
  expect(response.status).toBe(400);
  const loaded = await h.app.request(`${pathname}/load`, { method: "POST", body: JSON.stringify({ token }) });
  expect((await loaded.json()).form.questions[0].options).toHaveLength(2);
});

test("questions must have separate answer identities", async () => {
  const h = await setup();
  await expect(h.ask({ title: "Ambiguous answers", summary: "Two different decisions need separate answers.", questions: [{ id: "same", type: "text", question: "First decision?" }, { id: "same", type: "text", question: "Second decision?" }] })).rejects.toThrow("unique");
});

test.each(["constructor", "__proto__"])("reserved answer identity %s is refused clearly before a form is created", async (id) => {
  const h = await setup();
  await expect(h.ask({ title: "Answer identity", summary: "A decision needs a safe answer identity.", questions: [{ id, type: "text", question: "Which release?" }] })).rejects.toThrow("reserved");
});

test("host-supported agent identifiers can create, open and resume forms", async () => {
  const h = await setup();
  h.agent.id = "guide.preview";
  const opened = await h.ask();
  const page = await h.app.request(new URL(opened.link).pathname);
  expect(page.status).toBe(200);
  const token = JSON.parse((await page.text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  expect((await h.app.request(`${new URL(opened.link).pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  expect(h.runAgent.mock.calls[0][0].agentId).toBe("guide.preview");
});

test("queued wakes finish durably without waiting for a callback, and deferred replies deliver once", async () => {
  const h = await setup();
  const opened = await h.ask();
  const pathname = new URL(opened.link).pathname;
  const token = JSON.parse((await (await h.app.request(pathname)).text()).match(/<script id="interview-bootstrap" type="application\/json">([^]*?)<\/script>/)![1]).token;
  h.runAgent.mockResolvedValueOnce({ payloads: [], meta: { sessionId: "main-session", queued: true } });
  expect((await h.app.request(`${pathname}/submit`, { method: "POST", body: JSON.stringify({ token, answers }) })).status).toBe(200);
  await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.sink).toHaveBeenCalledOnce();
  const restarted = await setup(h.dataDir);
  expect(restarted.runAgent).not.toHaveBeenCalled();
  await h.runAgent.mock.calls[0][0].onDeferredResult!({ result: { payloads: [{ text: "Deferred continuation" }], meta: { sessionId: "main-session" } } });
  expect(h.sink).toHaveBeenCalledTimes(2);
  expect(h.sink.mock.calls[1][0].text).toBe("Deferred continuation");
});
