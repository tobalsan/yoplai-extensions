import { z } from "zod";

export const OptionSchema = z.object({ label: z.string().min(1), description: z.string().optional() });
export const QuestionSchema = z.object({
  id: z.string().min(1).refine((id) => !Object.hasOwn(Object.prototype, id), "Question id is reserved; choose a different id"), type: z.enum(["single", "multi", "text", "info"]),
  question: z.string().min(1), options: z.array(OptionSchema).max(12).optional(),
  recommended: z.union([z.string(), z.array(z.string())]).optional(), context: z.string().optional(),
});
export const AskSchema = z.object({ title: z.string().min(1), summary: z.string().min(1), questions: z.array(QuestionSchema).min(1).max(30) }).superRefine((form, ctx) => {
  if (new Set(form.questions.map((question) => question.id)).size !== form.questions.length) ctx.addIssue({ code: "custom", message: "Question ids must be unique", path: ["questions"] });
});
export const AnswersSchema = z.record(z.object({ selected: z.array(z.string()).optional(), other: z.string().optional(), note: z.string().optional(), text: z.string().optional() }));
export type Question = z.infer<typeof QuestionSchema>;
export type Answers = z.infer<typeof AnswersSchema>;
export type FormView = z.infer<typeof AskSchema> & { id: string; draft: Answers; answers?: Answers; state: "pending" | "submitted" };
export type Origin = { sink: string; destination: { channel?: string; user?: string } };
export type Form = FormView & {
  agentId: string; sessionId: string; sessionOwnerId?: string | null; ownerUserId: string;
  requesterId?: string; origin?: Origin; wake: "none" | "pending" | "done"; createdAt: number; updatedAt: number;
};

export function answerError(form: Form, answers: Answers): string | undefined {
  if (Buffer.byteLength(JSON.stringify(answers)) > 256 * 1024) return "Answers must fit within 256 KB";
  for (const [id, answer] of Object.entries(answers)) {
    const question = form.questions.find((entry) => entry.id === id);
    if (!question || question.type === "info") return "Unknown answer question";
    if (question.type === "text") {
      if (answer.selected || answer.other !== undefined) return "Text questions accept text answers";
    } else {
      if (answer.text !== undefined) return "Choice questions accept options or Other";
      const selected = answer.selected ?? [];
      if (question.type === "single" && selected.length + (answer.other !== undefined ? 1 : 0) > 1) return "Choose one option";
      if (new Set(selected).size !== selected.length || selected.some((label) => !question.options?.some((option) => option.label === label))) return "Choose a listed option or Other";
    }
  }
  return undefined;
}

export function formView(form: Form): FormView {
  const { id, title, summary, questions, draft, answers, state } = form;
  return { id, title, summary, questions, draft, answers, state };
}
