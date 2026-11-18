import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defineToolExtension } from "../tool-extension.js";
import { AskSchema, AnswersSchema, OptionSchema, answerError, formView, type Form, type Origin } from "./model.js";
import { FormStore } from "./store.js";
import { renderFormPage } from "./page.js";

type Agent = { id: string; extensions?: Record<string, unknown> };
type Config = { extensions?: Record<string, unknown>; server?: { baseUrl?: string }; web?: { baseUrl?: string }; ui?: { port?: number } };
type RunResult = { payloads: Array<{ text?: string }>; meta: { sessionId: string; queued?: boolean } };
export type InterviewRunParams = {
  agentId: string; sessionId?: string; sessionKey?: string; sessionOwnerId?: string | null; userId?: string; requesterId?: string;
  message: string; source?: string; origin?: Origin; background?: boolean; signal?: AbortSignal;
  onDeferredResult?: (outcome: { result: RunResult } | { error: unknown }) => void | Promise<void>;
};
export type InterviewHost = {
  getConfig(): Config; getDataDir(): string; getAgent(id: string): Agent | undefined;
  pageRoutePrefix?: string; supportsFrameViews?: boolean; canUserAccessAgent?(userId: string, agentId: string): Promise<boolean>;
  runAgent(params: InterviewRunParams): Promise<RunResult>; deleteSession(agentId: string, sessionId: string): void;
  resetSession?(agentId: string, sessionId: string, userId?: string): Promise<void>;
  getDeliverySink(id: string): ((input: { agent: Agent; destination: Origin["destination"]; text: string }) => Promise<void>) | undefined;
  logger: { error(message: string, error?: unknown): void; warn(message: string): void };
};
type ToolContext = { config: Config; sessionId?: string; sessionOwnerId?: string | null; userId?: string; requesterId?: string; origin?: Origin; signal?: AbortSignal; emitProgress?: (event: { label: string }) => void };
declare module "hono" {
  interface ContextVariableMap { multiUserAuthContext: unknown }
}

export function createInterviewExtension() {
  let host: InterviewHost;
  let store: FormStore;
  const signingKey = randomBytes(32);
  const waiters = new Map<string, Set<(form: Form) => void>>();
  const waking = new Set<string>();
  const assisting = new Set<string>();
  const multiUser = () => !!(host.getConfig().extensions?.multiUser as { enabled?: boolean } | undefined)?.enabled;
  const baseUrl = () => {
    const config = host.getConfig();
    return ([config.server?.baseUrl, config.web?.baseUrl].find((value) => value?.trim())?.trim() ?? `http://localhost:${config.ui?.port ?? 3000}`).replace(/\/+$/, "");
  };
  const formPath = (form: Pick<Form, "agentId" | "id">) => `${host.pageRoutePrefix}/${encodeURIComponent(form.agentId)}/${form.id}`;
  const link = (form: Form) => `${baseUrl()}${formPath(form)}`;
  const sign = (payload: string) => createHmac("sha256", signingKey).update(payload).digest("base64url");
  const issueToken = (form: Form) => {
    const payload = Buffer.from(JSON.stringify({ id: form.id, userId: form.ownerUserId, expiresAt: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };
  const verifyToken = (token: unknown, form: Form) => {
    if (typeof token !== "string") return false;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return false;
    const expected = Buffer.from(sign(payload)), actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    try { const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return claims.id === form.id && claims.userId === form.ownerUserId && claims.expiresAt > Date.now(); }
    catch { return false; }
  };
  async function deliver(form: Form, text: string) {
    if (!form.origin || !text) return;
    const agent = host.getAgent(form.agentId), sink = host.getDeliverySink(form.origin.sink);
    if (!agent || !sink) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sink({ agent, destination: form.origin.destination, text }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Interview delivery timed out")), 15_000); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  function answerText(form: Form) {
    return form.questions.filter((q) => q.type !== "info").map((q) => {
      const answer = form.answers?.[q.id];
      return `${q.question}: ${[...(answer?.selected ?? []), answer?.other, answer?.text, answer?.note].filter(Boolean).join("; ")}`;
    }).join("\n");
  }
  async function wake(form: Form) {
    if (waking.has(form.id)) return;
    waking.add(form.id);
    try {
    try { await deliver(form, `${form.title}\n${answerText(form)}`.slice(0, 1500)); }
    catch (error) { host.logger.error("Interview recap delivery failed", error); }
    const result = await host.runAgent({
      agentId: form.agentId, sessionId: form.sessionId, sessionOwnerId: form.sessionOwnerId,
      userId: form.ownerUserId === "local" ? undefined : form.ownerUserId, requesterId: form.requesterId, origin: form.origin,
      source: "interview", message: `Interview submitted: ${form.title} (${form.id})\n${answerText(form)}`,
      onDeferredResult: async (outcome) => { if ("result" in outcome) await deliver(form, outcome.result.payloads.map((p) => p.text ?? "").join("\n")); },
    });
    form.wake = "done"; form.updatedAt = Date.now(); store.put(form);
    if (!result.meta.queued) await deliver(form, result.payloads.map((p) => p.text ?? "").join("\n"));
    } finally { waking.delete(form.id); }
  }
  const schema = (value: z.ZodTypeAny) => zodToJsonSchema(value, { $refStrategy: "none" }) as Record<string, unknown>;
  const reply = (c: Context, status: 200 | 400 | 401 | 403 | 404 | 409 | 500, body: Record<string, unknown>) => c.json(body, status, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  const extension = defineToolExtension({ id: "interview", displayName: "Interview", description: "Ask a batch of questions through a form", requiredSecrets: [], configSchema: z.object({}), createTools: () => [] });
  return {
    ...extension,
    tokenAuthenticatedRoutes: ["load", "draft", "submit", "assist"].map((op) => ({ method: "POST" as const, path: `/:agentId/:id/${op}` })),
    async start(ctx: InterviewHost) {
      host = ctx; store = new FormStore(ctx.getDataDir());
      for (const form of store.pendingWakes()) void wake(form).catch((error) => host.logger.error("Interview wake retry failed", error));
    },
    registerPageRoutes(app: Hono) {
      app.get("/:agentId/:id", async (c) => {
        const form = store.get(c.req.param("agentId"), c.req.param("id"));
        if (!form) return c.notFound();
        const auth = c.get("multiUserAuthContext") as { user?: { id?: string }; impersonator?: unknown } | null;
        const viewer = multiUser() ? auth?.user?.id : "local";
        if (viewer !== form.ownerUserId || !await host.canUserAccessAgent?.(viewer, form.agentId)) return c.text("Not found", 404);
        const token = !auth?.impersonator ? issueToken(form) : undefined;
        const cookieTheme = c.req.header("cookie")?.match(/(?:^|;\s*)yoplai-theme=(light|dark)(?:;|$)/)?.[1];
        return c.html(renderFormPage({ form: formView(form), token, apiBase: formPath(form), theme: cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : null }), 200, { "Cache-Control": "no-store" });
      });
      for (const operation of ["load", "draft", "submit", "assist"] as const) app.post(`/:agentId/:id/${operation}`, async (c) => {
        let form = store.get(c.req.param("agentId"), c.req.param("id"));
        if (!form) return reply(c, 404, { ok: false, error: "Form not found" });
        let body: Record<string, unknown>;
        try {
          const raw = await c.req.text();
          if (Buffer.byteLength(raw) > 256 * 1024 + 4096) return reply(c, 400, { ok: false, error: "Request must fit within 256 KB" });
          body = z.record(z.unknown()).parse(JSON.parse(raw));
        } catch { return reply(c, 400, { ok: false, error: "Invalid request" }); }
        if (!verifyToken(body.token, form)) return reply(c, 401, { ok: false, error: "Reload the form to continue" });
        if (!await host.canUserAccessAgent?.(form.ownerUserId, form.agentId)) return reply(c, 403, { ok: false, error: "Access revoked" });
        // Authentication awaits can interleave requests; begin the atomic transition with a fresh read.
        form = store.get(form.agentId, form.id)!;
        if (operation === "load") return reply(c, 200, { ok: true, form: formView(form) });
        if (form.state === "submitted") return reply(c, 409, { ok: false, answers: form.answers, error: "Already submitted" });
        if (operation === "assist") {
          const parsed = z.object({ action: z.enum(["ask", "generate", "review"]), questionId: z.string(), option: z.string().optional(), prompt: z.string().optional() }).safeParse(body);
          const question = parsed.success && form.questions.find((q) => q.id === parsed.data.questionId);
          if (!parsed.success || !question) return reply(c, 400, { ok: false, error: "Choose a question" });
          if (assisting.has(form.id)) return reply(c, 409, { ok: false, error: "An assist is already running for this form" });
          assisting.add(form.id);
          const controller = new AbortController();
          let sessionId: string = randomUUID();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const instruction = parsed.data.action === "generate" ? 'Generate a few additional choices. Return JSON: {"options":[{"label":"...","description":"..."}]}.'
              : parsed.data.action === "review" ? 'Critique the choices. Return JSON: {"text":"..."}.' : "Explain the targeted question or option and answer the human's question.";
            const result = await Promise.race([
              host.runAgent({ agentId: form.agentId, sessionId, sessionKey: `interview-assist:${form.id}:${sessionId}`, background: true, source: "interview", userId: form.ownerUserId === "local" ? undefined : form.ownerUserId, signal: controller.signal,
                message: `You are assisting a human with an interview. Answer using only this context; do not call tools.\n${instruction}\nSituation: ${form.summary}\nFull question list: ${JSON.stringify(form.questions)}\nTarget: ${JSON.stringify({ question, option: parsed.data.option })}\nHuman question: ${parsed.data.prompt ?? ""}` }),
              new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("Assist timed out after 90 seconds. Try again.")); }, 90_000); }),
            ]);
            sessionId = result.meta.sessionId;
            const text = result.payloads.map((payload) => payload.text ?? "").join("\n");
            if (parsed.data.action !== "ask") {
              try {
                const json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
                if (parsed.data.action === "generate") {
                  const generated = z.object({ options: z.array(OptionSchema).max(12) }).parse(json);
                  return reply(c, 200, { ok: true, options: generated.options });
                }
                if (typeof json.text === "string") return reply(c, 200, { ok: true, text: json.text });
              } catch { /* Model output may be prose; show it as text. */ }
            }
            return reply(c, 200, { ok: true, text });
          } catch (error) { return reply(c, 500, { ok: false, error: error instanceof Error ? error.message : "Assist failed. Try again." }); }
          finally {
            clearTimeout(timeout); controller.abort();
            try { await host.resetSession?.(form.agentId, sessionId, form.ownerUserId === "local" ? undefined : form.ownerUserId); }
            catch (error) { host.logger.error("Interview assist history cleanup failed", error); }
            finally { host.deleteSession(form.agentId, sessionId); assisting.delete(form.id); }
          }
        }
        const parsed = AnswersSchema.safeParse(body.answers);
        if (!parsed.success) return reply(c, 400, { ok: false, error: "Invalid answers" });
        const invalidAnswer = answerError(form, parsed.data);
        if (invalidAnswer) return reply(c, 400, { ok: false, error: invalidAnswer });
        if (operation === "draft") {
          if (body.addOption !== undefined) {
            const addition = z.object({ questionId: z.string(), option: OptionSchema }).safeParse(body.addOption);
            const question = addition.success && form.questions.find((q) => q.id === addition.data.questionId && (q.type === "single" || q.type === "multi"));
            if (!addition.success || !question) return reply(c, 400, { ok: false, error: "Invalid option" });
            if (!question.options?.some((option) => option.label === addition.data.option.label)) {
              if ((question.options?.length ?? 0) >= 12) return reply(c, 400, { ok: false, error: "A question can have at most 12 options" });
              question.options = [...(question.options ?? []), addition.data.option];
            }
          }
          if (Buffer.byteLength(JSON.stringify({ ...form, draft: {}, answers: undefined })) > 256 * 1024) return reply(c, 400, { ok: false, error: "Form must fit within 256 KB" });
          form.draft = parsed.data; form.updatedAt = Date.now(); store.put(form);
          return reply(c, 200, { ok: true, form: formView(form) });
        }
        const liveWaiters = waiters.get(form.id);
        form.answers = parsed.data; form.state = "submitted"; form.wake = liveWaiters?.size ? "none" : "pending"; form.updatedAt = Date.now(); store.put(form);
        if (liveWaiters?.size) {
          // Release the tool before delivery so an unavailable surface never holds the main turn.
          for (const resolve of liveWaiters) resolve(form);
          void deliver(form, `${form.title}\n${answerText(form)}`.slice(0, 1500)).catch((error) => host.logger.error("Interview recap delivery failed", error));
        } else void wake(form).catch((error) => host.logger.error("Interview wake failed", error));
        return reply(c, 200, { ok: true, answers: form.answers });
      });
    },
    async getAgentTools(agent: Agent, context: ToolContext) {
      if (agent.extensions?.interview === undefined || (agent.extensions.interview as { enabled?: boolean })?.enabled === false) return [];
      return [
        { name: "interview_ask" as const, description: "Create a batch interview form and return its link immediately. Follow the returned instructions.", parameters: schema(AskSchema),
          outputSchema: schema(z.object({ status: z.literal("open"), id: z.string(), link: z.string(), instructions: z.string() })),
          execute: async (input: unknown, execution: ToolContext = context) => {
            if (!host?.pageRoutePrefix || !host.canUserAccessAgent) throw new Error("Interview requires a host with extension page routes and agent access checks. Upgrade the gateway.");
            if (multiUser() && !execution.userId) throw new Error("The human must link their account to the gateway first; interview cannot create a form without a gateway user.");
            if (!execution.sessionId) throw new Error("Interview requires a session");
            const form: Form = { ...AskSchema.parse(input), id: randomUUID(), agentId: agent.id, sessionId: execution.sessionId,
              sessionOwnerId: execution.sessionOwnerId, ownerUserId: multiUser() ? execution.userId! : "local", requesterId: execution.requesterId,
              origin: execution.origin, draft: {}, state: "pending", wake: "none", createdAt: Date.now(), updatedAt: Date.now() };
            if (Buffer.byteLength(JSON.stringify(form)) > 256 * 1024) throw new Error("Form must fit within 256 KB");
            store.put(form);
            return { status: "open", id: form.id, link: link(form), instructions: form.origin ? "Put the form link in your reply (or post it first with the surface's post tool) and end the turn. Submit wakes this session; a long wait hides the link until you reply." : "Call interview_wait now. If pending, end the turn; submit will wake this session.",
              ...(!form.origin && host.supportsFrameViews ? { frameView: { url: formPath(form), title: form.title, key: form.id } } : {}) };
          } },
        { name: "interview_wait" as const, description: "Wait for answers to a form.", parameters: schema(z.object({ id: z.string(), waitSeconds: z.number().optional() })),
          outputSchema: schema(z.object({ status: z.enum(["answered", "pending"]), id: z.string(), answers: AnswersSchema.optional(), link: z.string().optional() })),
          execute: async (input: unknown, execution: ToolContext = context) => {
            const { id, waitSeconds = 240 } = z.object({ id: z.string(), waitSeconds: z.number().min(0).optional() }).parse(input); const form = store.get(agent.id, id);
            if (!form || form.sessionId !== execution.sessionId || form.ownerUserId !== (multiUser() ? execution.userId : "local")) throw new Error("Form not found");
            if (form.state === "submitted") return { status: "answered", id, answers: form.answers };
            return new Promise<Record<string, unknown>>((resolve, reject) => {
              const set = waiters.get(id) ?? new Set(); waiters.set(id, set);
              const finish = (submitted?: Form, error?: unknown) => {
                clearTimeout(timeout); clearInterval(heartbeat); set.delete(answered); if (!set.size) waiters.delete(id);
                execution.signal?.removeEventListener("abort", abort);
                if (error !== undefined) reject(error);
                else resolve(submitted ? { status: "answered", id, answers: submitted.answers } : { status: "pending", id, link: link(form) });
              };
              const answered = (submitted: Form) => finish(submitted);
              const timeout = setTimeout(() => finish(), Math.min(waitSeconds, 270) * 1000);
              const heartbeat = setInterval(() => execution.emitProgress?.({ label: "Waiting for interview answers" }), 60_000);
              const abort = () => finish(undefined, execution.signal?.reason ?? new Error("Interview wait cancelled"));
              set.add(answered);
              execution.signal?.addEventListener("abort", abort, { once: true });
              if (execution.signal?.aborted) abort();
            });
          } },
      ];
    },
  };
}

export default createInterviewExtension();
