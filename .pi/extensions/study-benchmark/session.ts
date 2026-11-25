import type { Grade, Question } from "./grading.ts";

// Phase 1 exposes the single grammar rule supported by the generator.
export const studyGrammar = ["polite-past"] as const;

export function studyCommand(args: string): number | undefined {
  const input = args.trim();
  if (!input) return undefined;
  if (input === "drilling") return 10;
  const match = /^drilling\s+--q\s+(\d+)$/.exec(input);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1)
    throw new Error("Usage: /study drilling [--q <positive integer>]");
  return Number(match[1]);
}

export function studyCompletions(prefix: string) {
  const options = ["drilling", "drilling --q", "drilling --q 10"];
  const next = options.find(option => option.startsWith(prefix) && option !== prefix.trimEnd());
  return next ? [{ value: next, label: next }] : null;
}

type Attempt = { answer: string; grade: Grade };
type Outcome = "correct" | "exhausted" | "gave_up";
type StudyView = {
  answer(state: { prompt: string; draft: string; attempts: Attempt[]; gradingFailed: boolean; failure: string }): Promise<
    { action: "submit"; answer: string } | { action: "give_up" | "exit" }
  >;
  grade(question: Question, answer: string): Promise<Grade>;
  reveal(question: Question, outcome: Outcome, lastGrade?: Grade, submittedAnswer?: string): Promise<boolean>;
};

export async function runQuestions(questions: Question[], view: StudyView) {
  const records: { attempts: Attempt[]; outcome?: Outcome }[] = [];
  for (const [index, question] of questions.entries()) {
    const record: typeof records[number] = { attempts: [] };
    records.push(record);
    let draft = "";
    let failure = "";
    const prompt = `Question ${index + 1}/${questions.length}\n${question.english}`;
    while (!record.outcome) {
      const input = await view.answer({ prompt, draft, attempts: record.attempts, gradingFailed: !!failure, failure });
      if (input.action === "exit") return { records, completed: false };
      if (input.action === "give_up") {
        record.outcome = "gave_up";
        break;
      }
      if (input.action !== "submit") continue;
      draft = input.answer;
      if (!draft.trim()) continue;
      let grade: Grade;
      try {
        grade = await view.grade(question, draft.trim());
      } catch (error) {
        failure = error instanceof Error ? error.message : "Grading request failed.";
        continue;
      }
      failure = "";
      record.attempts.push({ answer: draft, grade });
      if (grade.verdict === "correct") record.outcome = "correct";
      else if (record.attempts.length === 3) record.outcome = "exhausted";
    }
    if (!await view.reveal(question, record.outcome, record.attempts.at(-1)?.grade, record.attempts.at(-1)?.answer))
      return { records, completed: false };
  }
  return { records, completed: true };
}
