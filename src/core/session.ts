import type { Grade, Question } from "./grading.ts";

import type { Entry } from "./vocabulary.ts";
import type { Analyze } from "./generation.ts";

type Attempt = { responseMs: number; answer: string; grade: Grade };
type Outcome = "correct" | "partially_correct" | "exhausted" | "gave_up";
const maxAttempts = 3;
type StudyView = {
  begin?(question: Question): void;
  answer(state: { prompt: string; draft: string; attempts: Attempt[]; gradingFailed: boolean; failure: string; hint: string; remaining: number }): Promise<
    { action: "submit"; answer: string } | { action: "give_up" | "exit" | "hint" }
  >;
  analyze?: Analyze;
  known?: Set<string>;
  confirm?(entry: Entry): Promise<"yes" | "no" | "skip">;
  save?(entry: Entry): Promise<void>;
  error?(message: string): void;
  grade(question: Question, answer: string, attemptsRemainingAfterSubmission: number): Promise<Grade>;
  reveal(question: Question, outcome: Outcome, lastGrade?: Grade, submittedAnswer?: string): Promise<boolean>;
};

export async function runQuestions(questions: Question[], view: StudyView) {
  const started = Date.now();
  const asked = new Set<string>();
  const confirmed: Entry[] = [];
  const records: { question: Question; responseMs: number; hintUsed: boolean; attempts: Attempt[]; outcome?: Outcome }[] = [];
  const finish = (completed: boolean) => ({ completed, records, confirmed, total: questions.length, durationMs: Date.now() - started });
  for (const [index, question] of questions.entries()) {
    view.begin?.(question);
    const record: typeof records[number] = { question, responseMs: 0, hintUsed: false, attempts: [] };
    records.push(record);
    let cachedHint = "";
    let hint = "";
    let responseMs = 0;
    let draft = "";
    let failure = "";
    const prompt = `Question ${index + 1}/${questions.length}\n${question.english}`;
    while (!record.outcome) {
      const answering = Date.now();
      const input = await view.answer({ prompt, draft, attempts: record.attempts, gradingFailed: !!failure, failure, hint, remaining: maxAttempts - record.attempts.length });
      const elapsed = Date.now() - answering;
      record.responseMs += elapsed;
      responseMs += elapsed;
      if (input.action === "hint" && view.analyze) {
        try {
          if (hint) hint = "";
          else {
            cachedHint ||= cloze((await view.analyze([question.referenceJa]))[0]);
            hint = cachedHint;
            record.hintUsed = true;
          }
        } catch { view.error?.("Hint unavailable."); }
        continue;
      }
      if (input.action === "exit") return finish(false);
      if (input.action === "give_up") {
        record.outcome = "gave_up";
        break;
      }
      if (input.action !== "submit") continue;
      draft = input.answer;
      if (!draft.trim()) continue;
      let grade: Grade;
      try {
        grade = await view.grade(question, draft.trim(), maxAttempts - record.attempts.length - 1);
      } catch (error) {
        failure = error instanceof Error ? error.message : "Grading request failed.";
        continue;
      }
      failure = "";
      record.attempts.push({ answer: draft, grade, responseMs });
      responseMs = 0;
      if (grade.verdict !== "incorrect") record.outcome = grade.verdict;
      else if (record.attempts.length === maxAttempts) record.outcome = "exhausted";
    }
    const advance = await view.reveal(question, record.outcome, record.attempts.at(-1)?.grade, record.attempts.at(-1)?.answer);
    for (const word of question.words ?? []) {
      const headword = word.lemma.normalize("NFC").trim();
      if (asked.has(headword) || view.known?.has(headword) || !view.confirm || !view.save) continue;
      asked.add(headword);
      const entry = { headword, reading: word.reading, meaning: word.meaning };
      if (await view.confirm(entry) === "yes") {
        try {
          await view.save(entry);
          view.known?.add(headword);
          confirmed.push(entry);
        } catch { view.error?.("Could not save " + headword + "."); }
      }
    }
    if (!advance) return finish(false);
  }
  return finish(true);
}

export function cloze(tokens: Awaited<ReturnType<Analyze>>[number]) {
  return tokens.map(([surface, lemma, pos, , , , subtype], i) => {
    const previous = tokens[i - 1]?.[0];
    if ((previous === "て" || previous === "で") && ["いる", "くださる", "しまう", "おく"].includes(lemma)) return surface;
    if (["つもり", "よう"].includes(lemma) || subtype === "助動詞語幹") return surface;
    if (pos === "形容詞") return "＿＿" + (surface.match(/かった$|く$|い$/)?.[0] ?? "");
    return ["名詞", "代名詞", "動詞", "形状詞", "副詞", "連体詞"].includes(pos) ? "＿＿" : surface;
  }).join("");
}

export function summary(result: Awaited<ReturnType<typeof runQuestions>>) {
  const done = result.records.filter(r => r.outcome);
  const count = (outcome: Outcome) => done.filter(r => r.outcome === outcome).length;
  const first = done.filter(r => r.attempts[0]?.grade.verdict === "correct").length;
  const attempted = result.records.filter(r => r.attempts.length).length;
  const tiers = ["easy", "medium", "hard"].flatMap(tier => {
    const group = done.filter(r => r.question.difficulty === tier);
    return group.length ? [tier + " " + group.filter(r => r.outcome === "correct").length + "/" + group.length] : [];
  });
  return [
    "Completed " + done.length + "/" + result.total + "  ·  " + Math.round(result.durationMs / 1000) + "s",
    "Correct first try " + first + "  ·  After retries " + (count("correct") - first),
    "Partial " + count("partially_correct") + "  ·  Unsolved " + count("exhausted") + "  ·  Surrendered " + count("gave_up"),
    "First-attempt accuracy " + (attempted ? Math.round(100 * first / attempted) + "%" : "n/a") + "  ·  Completed with hints " + done.filter(r => r.hintUsed).length,
    "Correct by difficulty: " + (tiers.join("  ·  ") || "—"),
    "New vocabulary: " + (result.confirmed.map(entry => entry.headword).join("、") || "—"),
  ].join("\n");
}
