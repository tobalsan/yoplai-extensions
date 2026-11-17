import type { Answers, FormView } from "./model.js";

type PageData = { form: FormView; token?: string; apiBase: string; theme?: "light" | "dark" | null };

export function renderFormPage(data: PageData): string {
  const bootstrap = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const theme = data.theme ? ` data-theme="${data.theme}"` : "";
  return `<!doctype html><html lang="en"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interview</title><link rel="stylesheet" href="/d-assets/v3/kit.css"><style>
main.interview { max-width: 760px; padding: 32px 24px 80px; }
.interview header { margin-bottom: 32px; }
.interview h1 { margin-bottom: 12px; }
.interview .question { margin: 0 0 32px; scroll-margin: 24px; }
.interview .question h2 { margin: 0 0 12px; font-size: 1.125rem; }
.interview .context, .interview #summary { color: var(--dk-muted); }
.interview .context { margin: 8px 0 12px; font-size: 0.875rem; }
.interview .info { padding: 16px 0; }
.interview .info h2 { margin-top: 0; }
.interview .option { display: flex; align-items: flex-start; gap: 12px; margin: 0 0 8px; }
.interview .option label { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; width: 100%; cursor: pointer; padding: 8px 12px; border: 1px solid var(--dk-border-subtle); border-radius: 8px; }
.interview .option label:has(input:checked) { border-color: var(--dk-accent); background: color-mix(in srgb, var(--dk-accent) 7%, var(--dk-surface)); }
.interview .option label:hover { background: var(--dk-surface-2); }
.interview input[type="radio"], .interview input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; min-height: 0; margin: 4px 0 0; padding: 0; accent-color: var(--dk-accent); }
.interview .option-copy { flex: 1; min-width: 0; }
.interview .option-name { font-weight: 500; overflow-wrap: anywhere; }
.interview .description { display: block; color: var(--dk-muted); font-size: 0.875rem; margin-top: 2px; }
.interview .recommended { display: inline-block; margin-left: 8px; color: var(--dk-link); font-size: 0.75rem; font-weight: 500; }
.interview textarea { display: block; width: 100%; min-height: 88px; padding: 12px; margin: 8px 0 0; resize: vertical; color: var(--dk-text); background: var(--dk-surface); border: 1px solid var(--dk-border); border-radius: 8px; font: inherit; caret-color: var(--dk-accent); }
.interview .text-label { display: block; color: var(--dk-muted); font-size: 0.875rem; }
.interview .note-toggle { margin-top: 8px; }
.interview .note { margin-top: 8px; }
.interview .assist-actions { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 8px; }
.interview .assist-actions .dk-link-button { padding-left: 0; padding-right: 8px; }
.interview .option > .dk-link-button { flex: 0 0 auto; }
.interview .ask-box, .interview .assist-result { margin-top: 12px; padding: 16px; border-radius: 8px; background: var(--dk-surface-2); }
.interview .ask-box textarea { margin-bottom: 8px; }
.interview .assist-result p:last-child { margin-bottom: 0; }
.interview .generated-option { margin-top: 12px; }
.interview #shortcuts { color: var(--dk-muted); font-size: 0.875rem; margin: 24px 0 16px; }
.interview #shortcuts summary { cursor: pointer; min-height: 40px; padding: 8px 0; }
.interview #shortcuts dl { display: grid; grid-template-columns: minmax(100px, auto) 1fr; gap: 8px 16px; margin: 8px 0; }
.interview #shortcuts dt { font-weight: 500; color: var(--dk-text); }
.interview #shortcuts dd { margin: 0; }
.interview .other { width: 100%; min-height: 40px; margin: 0 0 8px; }
.interview .actions { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 12px; padding: 16px 0; background: var(--dk-bg); border-top: 1px solid var(--dk-border-subtle); }
.interview .actions [role="status"] { flex: 1; color: var(--dk-muted); font-size: 0.875rem; }
.interview button { min-height: 40px; }
.interview button.primary { color: var(--dk-surface); background: var(--dk-accent); border-color: var(--dk-accent); font-weight: 600; }
.interview button.primary:hover { background: var(--dk-link); }
.interview textarea:disabled, .interview input:disabled { opacity: 1; cursor: default; }
.interview button:disabled { opacity: 0.55; cursor: default; }
.interview .error { color: var(--dk-negative) !important; }
.interview [hidden] { display: none !important; }
.interview ::selection { background: color-mix(in srgb, var(--dk-accent) 24%, transparent); }
@media (max-width: 480px) { main.interview { padding: 24px 16px 80px; } }
</style><script src="/d-assets/v3/marked.js"></script><script src="/d-assets/v3/purify.js"></script></head><body><main class="interview"><header><h1></h1><div id="summary"></div></header><div id="questions"></div><details id="shortcuts"><summary>Keyboard shortcuts</summary><dl><dt>Arrows or j / k</dt><dd>Move between questions</dd><dt>1–9</dt><dd>Pick an option</dd><dt>o / n</dt><dd>Other answer / note</dd><dt>Cmd/Ctrl+S</dt><dd>Save draft</dd><dt>Cmd/Ctrl+Enter</dt><dd>Submit answers</dd><dt>?</dt><dd>Show or hide this help</dd></dl></details><footer class="actions"><span id="save-status" role="status" aria-live="polite"></span><button id="save-draft" type="button" class="dk-button">Save draft</button><button id="submit" type="button" class="dk-button primary">Submit</button></footer></main><script id="interview-bootstrap" type="application/json">${bootstrap}</script><script>(${boot.toString()})()</script></body></html>`;
}

function boot() {
  const data: PageData = JSON.parse(document.getElementById("interview-bootstrap")!.textContent!);
  const runtime = window as Window & { marked?: { parse(text: string): string }; DOMPurify?: { sanitize(html: string): string } };
  document.title = data.form.title;
  document.querySelector("h1")!.textContent = data.form.title;
  function markdown(target: HTMLElement, text: string) {
    if (runtime.marked && runtime.DOMPurify) target.innerHTML = runtime.DOMPurify.sanitize(runtime.marked.parse(text));
    else target.textContent = text;
  }
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  markdown(document.getElementById("summary")!, data.form.summary);
  let answers: Answers = JSON.parse(JSON.stringify(data.form.answers ?? data.form.draft));
  const save = document.getElementById("save-draft") as HTMLButtonElement;
  const submit = document.getElementById("submit") as HTMLButtonElement;
  const status = document.getElementById("save-status")!;
  let dirty = false;
  let assisting = false;
  function changed() { dirty = true; status.textContent = "Unsaved changes"; status.classList.remove("error"); }
  function answer(id: string) { return answers[id] ?? (answers[id] = {}); }
  async function request(operation: string, body: Record<string, unknown>, timeoutMs = 15_000) {
    if (!data.token) throw new Error("This form is read-only");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${data.apiBase}/${operation}`, { method: "POST", credentials: "omit", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ ...body, token: data.token }), signal: controller.signal });
      const result = await response.json();
      if (response.status === 409 && result.answers) { lock(result.answers); return result; }
      if (!response.ok || !result.ok) throw new Error(result.error || `Could not save (${response.status})`);
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("The request timed out. Your answers are still here; try again.");
      throw error;
    } finally { window.clearTimeout(timeout); }
  }
  save.addEventListener("click", async () => {
    save.disabled = true;
    status.classList.remove("error");
    status.textContent = "Saving draft…";
    const snapshot = JSON.stringify(answers);
    try {
      await request("draft", { answers });
      if (data.form.state === "submitted") return;
      dirty = JSON.stringify(answers) !== snapshot;
      status.textContent = dirty ? "Unsaved changes" : "Draft saved";
    } catch (error) { status.textContent = error instanceof Error ? error.message : "Could not save. Try again."; status.classList.add("error"); }
    finally { save.disabled = !data.token; }
  });
  submit.addEventListener("click", async () => {
    save.disabled = submit.disabled = true;
    status.classList.remove("error");
    status.textContent = "Submitting…";
    try {
      const result = await request("submit", { answers });
      lock(result.answers);
    } catch (error) { status.textContent = error instanceof Error ? error.message : "Could not submit. Try again."; status.classList.add("error"); }
    finally { save.disabled = submit.disabled = !data.token || data.form.state === "submitted"; }
  });
  function lock(storedAnswers: Answers) {
    data.form.state = "submitted";
    answers = storedAnswers;
    dirty = false;
    renderQuestions();
    status.classList.remove("error");
    status.textContent = "Submitted. Your answers are locked.";
    save.hidden = submit.hidden = true;
  }
  window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
  function renderQuestions() {
  document.getElementById("questions")!.replaceChildren();
  data.form.questions.forEach((question, index) => {
    const section = element("section", question.type === "info" ? "question info" : "question");
    section.dataset.question = question.id;
    section.tabIndex = -1;
    document.getElementById("questions")!.append(section);
    if (question.type === "info") { markdown(section, question.question); return; }
    const heading = element("h2", "", question.question);
    heading.id = `question-${index}`;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    if (question.context) {
      const context = element("div", "context");
      markdown(context, question.context);
      section.append(context);
    }
    let askOption: string | undefined;
    const askBox = element("div", "ask-box");
    askBox.hidden = true;
    const askLabel = element("label", "text-label", "Ask about this question");
    askLabel.htmlFor = `ask-${index}`;
    const askInput = element("textarea");
    askInput.id = askLabel.htmlFor;
    askInput.dataset.ask = question.id;
    askInput.placeholder = "What would help you decide?";
    const sendAsk = element("button", "dk-button", "Ask");
    sendAsk.type = "button";
    sendAsk.dataset.sendAsk = question.id;
    const result = element("div", "assist-result");
    result.dataset.assistResult = question.id;
    result.setAttribute("aria-live", "polite");
    result.hidden = true;
    function showAsk(option?: string) {
      askOption = option;
      askLabel.textContent = option ? `Ask about ${option}` : "Ask about this question";
      askBox.hidden = false;
      askInput.focus();
    }
    async function assist(action: "ask" | "generate" | "review") {
      if (assisting || (action === "ask" && !askInput.value.trim())) return;
      assisting = true;
      document.querySelectorAll<HTMLButtonElement>("[data-assist],[data-ask-option],[data-send-ask]").forEach((button) => { button.disabled = true; });
      result.hidden = false;
      result.classList.remove("error");
      result.textContent = "Getting help…";
      try {
        const response = await request("assist", { action, questionId: question.id, ...(action === "ask" ? { option: askOption, prompt: askInput.value } : {}) }, 100_000);
        if (data.form.state === "submitted") return;
        result.replaceChildren();
        if (response.text) markdown(result, response.text);
        for (const option of response.options ?? []) {
          const item = element("div", "generated-option");
          item.append(element("strong", "", option.label));
          if (option.description) item.append(element("p", "description", option.description));
          const add = element("button", "dk-button", "Add option");
          add.type = "button";
          add.dataset.addOption = option.label;
          add.addEventListener("click", async () => {
            add.disabled = true;
            const snapshot = JSON.stringify(answers);
            try {
              const saved = await request("draft", { answers, addOption: { questionId: question.id, option } });
              if (data.form.state === "submitted") return;
              data.form.questions = saved.form.questions;
              dirty = JSON.stringify(answers) !== snapshot;
              renderQuestions();
              status.textContent = dirty ? "Unsaved changes" : "Option added and draft saved";
            } catch (error) { result.textContent = error instanceof Error ? error.message : "Could not add this option. Try again."; result.classList.add("error"); }
            finally { add.disabled = false; }
          });
          item.append(add);
          result.append(item);
        }
      } catch (error) { result.textContent = error instanceof Error ? error.message : "Could not get help. Try again."; result.classList.add("error"); }
      finally {
        assisting = false;
        document.querySelectorAll<HTMLButtonElement>("[data-assist],[data-ask-option],[data-send-ask]").forEach((button) => { button.disabled = !data.token || data.form.state === "submitted"; });
      }
    }
    sendAsk.addEventListener("click", () => { void assist("ask"); });
    askBox.append(askLabel, askInput, sendAsk);
    if (question.type === "text") {
      const label = element("label", "text-label", "Your answer");
      label.htmlFor = `answer-${index}`;
      const input = element("textarea");
      input.id = label.htmlFor;
      input.dataset.question = question.id;
      input.value = answers[question.id]?.text ?? "";
      input.addEventListener("input", () => { answer(question.id).text = input.value; changed(); });
      section.append(label, input);
    } else {
    const otherInput = element("input", "other");
    otherInput.type = "text";
    otherInput.dataset.other = question.id;
    otherInput.setAttribute("aria-label", `Other answer for ${question.question}`);
    otherInput.placeholder = "Your other answer";
    otherInput.value = answers[question.id]?.other ?? "";
    otherInput.hidden = !Object.hasOwn(answers[question.id] ?? {}, "other");
    otherInput.addEventListener("input", () => { answer(question.id).other = otherInput.value; changed(); });
    for (const [optionIndex, option] of [...(question.options ?? []), { label: "Other…" }].entries()) {
      const isOther = optionIndex === (question.options?.length ?? 0);
      const row = element("div", "option");
      const label = element("label");
      const input = element("input");
      input.type = question.type === "single" ? "radio" : "checkbox";
      input.name = `answer-${index}`;
      input.value = isOther ? "__other__" : option.label;
      if (isOther) input.dataset.otherChoice = "";
      input.checked = isOther ? Object.hasOwn(answers[question.id] ?? {}, "other") : answers[question.id]?.selected?.includes(option.label) ?? false;
      input.addEventListener("change", () => {
        const current = answer(question.id);
        if (isOther) {
          if (input.checked) current.other = otherInput.value;
          else delete current.other;
          if (question.type === "single") current.selected = [];
          otherInput.hidden = !input.checked;
        } else if (question.type === "single") {
          current.selected = [option.label]; delete current.other; otherInput.hidden = true;
        } else current.selected = input.checked ? [...(current.selected ?? []), option.label] : (current.selected ?? []).filter((value) => value !== option.label);
        changed();
      });
      const copy = element("span", "option-copy");
      const name = element("span", "option-name", isOther ? "Other…" : option.label);
      copy.append(name);
      if ([question.recommended].flat().includes(option.label)) name.append(element("span", "recommended", "Recommended"));
      if (option.description) copy.append(element("span", "description", option.description));
      label.append(input, copy);
      row.append(label);
      if (!isOther) {
        const optionAsk = element("button", "dk-link-button", "Ask");
        optionAsk.type = "button";
        optionAsk.dataset.askOption = option.label;
        optionAsk.setAttribute("aria-label", `Ask about ${option.label}`);
        optionAsk.addEventListener("click", () => showAsk(option.label));
        row.append(optionAsk);
      }
      section.append(row);
    }
    section.append(otherInput);
    }
    const noteToggle = element("button", "dk-link-button note-toggle", "Add note");
    noteToggle.type = "button";
    noteToggle.dataset.noteToggle = question.id;
    const note = element("textarea", "note");
    note.dataset.note = question.id;
    note.setAttribute("aria-label", `Optional note for ${question.question}`);
    note.placeholder = "Optional note";
    note.value = answers[question.id]?.note ?? "";
    note.hidden = !note.value;
    noteToggle.addEventListener("click", () => { note.hidden = !note.hidden; if (!note.hidden) note.focus(); });
    note.addEventListener("input", () => { answer(question.id).note = note.value; changed(); });
    section.append(noteToggle, note);
    const actions = element("div", "assist-actions");
    for (const [action, title] of [["ask", "Ask"], ["generate", "Generate more"], ["review", "Review options"]] as const) {
      if (question.type === "text" && action !== "ask") continue;
      const button = element("button", "dk-link-button", title);
      button.type = "button";
      button.dataset.assist = action;
      button.dataset.question = question.id;
      button.addEventListener("click", () => { if (action === "ask") showAsk(); else void assist(action); });
      actions.append(button);
    }
    section.append(actions, askBox, result);
    if (data.form.state === "submitted" || !data.token) {
      section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button").forEach((input) => { input.disabled = true; });
      noteToggle.hidden = true;
      actions.hidden = askBox.hidden = result.hidden = true;
      section.querySelectorAll<HTMLButtonElement>("[data-ask-option]").forEach((button) => { button.hidden = true; });
    }
  });
  }
  renderQuestions();
  if (data.form.state === "submitted") lock(answers);
  else if (!data.token) { save.hidden = submit.hidden = true; status.textContent = "Read-only while viewing as another user."; }
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (event.metaKey || event.ctrlKey) {
      if (key === "s") { event.preventDefault(); if (!save.hidden) save.click(); }
      if (key === "enter") { event.preventDefault(); if (!submit.hidden) submit.click(); }
      return;
    }
    if (event.altKey) return;
    const focused = document.activeElement as HTMLElement;
    if (focused.matches("input,textarea,select") || focused.isContentEditable) return;
    if (key === "?") {
      event.preventDefault();
      const help = document.getElementById("shortcuts") as HTMLDetailsElement;
      help.open = !help.open;
      return;
    }
    const sections = [...document.querySelectorAll<HTMLElement>("section.question")];
    const section = focused.closest<HTMLElement>("section.question") ?? sections.find((item) => !item.classList.contains("info")) ?? sections[0];
    if (!section) return;
    if (["j", "k", "arrowdown", "arrowup"].includes(key)) {
      event.preventDefault();
      const delta = key === "j" || key === "arrowdown" ? 1 : -1;
      const next = sections[Math.max(0, Math.min(sections.length - 1, sections.indexOf(section) + delta))];
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    } else if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      [...section.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]')].filter((input) => !input.hasAttribute("data-other-choice"))[Number(key) - 1]?.click();
    } else if (key === "o") {
      const other = section.querySelector<HTMLInputElement>("[data-other-choice]");
      if (other && !other.disabled) {
        event.preventDefault();
        if (!other.checked) other.click();
        section.querySelector<HTMLInputElement>("input[data-other]")?.focus();
      }
    } else if (key === "n") {
      const note = section.querySelector<HTMLTextAreaElement>("textarea[data-note]");
      if (note && !note.disabled) { event.preventDefault(); note.hidden = false; note.focus(); }
    }
  });
}
