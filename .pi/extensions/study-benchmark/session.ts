import type { Grade, Question } from "./grading.ts";

import { levels, type Difficulty } from "./grammar.ts";

export function studyCommand(args: string): { count: number; difficulty?: Difficulty; recent: boolean } | undefined {
  if (!args.trim()) return undefined;
  const [command, ...tokens] = args.trim().split(/\s+/);
  const options: { count: number; difficulty?: Difficulty; recent: boolean } = { count: 10, recent: false };
  const invalid = () => new Error("Usage: /study drilling [--q <positive integer>] [--difficulty easy|medium|hard] [--recent]");
  if (command !== "drilling") throw invalid();
  const seen = new Set<string>();
  while (tokens.length) {
    const flag = tokens.shift()!;
    if (seen.has(flag)) throw invalid();
    seen.add(flag);
    if (flag === "--recent") options.recent = true;
    else if (flag === "--difficulty") {
      const value = tokens.shift();
      const difficulty = levels.find(level => level === value);
      if (!difficulty) throw invalid();
      options.difficulty = difficulty;
    } else if (flag === "--q") {
      const value = tokens.shift() ?? "";
      const count = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) throw invalid();
      options.count = count;
    } else throw invalid();
  }
  return options;
}

export function studyCompletions(prefix: string) {
  const split = prefix.lastIndexOf(" ") + 1;
  const base = prefix.slice(0, split);
  const fragment = prefix.slice(split);
  const prior = base.trim().split(/\s+/);
  const last = prior.at(-1);
  const options = !base ? ["drilling"] : prior[0] !== "drilling" ? []
    : last === "--difficulty" ? levels : last === "--q" ? ["10"]
    : ["--q", "--difficulty", "--recent", "--debug"].filter(option => !prior.includes(option));
  const matches = options.filter(option => option.startsWith(fragment)).map(option => ({ value: base + option, label: option }));
  return matches.length ? matches : null;
}

type Attempt = { answer: string; grade: Grade };
type Outcome = "correct" | "partially_correct" | "exhausted" | "gave_up";
const maxAttempts = 3;
type StudyView = {
  begin?(question: Question): void;
  answer(state: { prompt: string; draft: string; attempts: Attempt[]; gradingFailed: boolean; failure: string }): Promise<
    { action: "submit"; answer: string } | { action: "give_up" | "exit" }
  >;
  grade(question: Question, answer: string, attemptsRemainingAfterSubmission: number): Promise<Grade>;
  reveal(question: Question, outcome: Outcome, lastGrade?: Grade, submittedAnswer?: string): Promise<boolean>;
};

export async function runQuestions(questions: Question[], view: StudyView) {
  const records: { attempts: Attempt[]; outcome?: Outcome }[] = [];
  for (const [index, question] of questions.entries()) {
    view.begin?.(question);
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
        grade = await view.grade(question, draft.trim(), maxAttempts - record.attempts.length - 1);
      } catch (error) {
        failure = error instanceof Error ? error.message : "Grading request failed.";
        continue;
      }
      failure = "";
      record.attempts.push({ answer: draft, grade });
      if (grade.verdict !== "incorrect") record.outcome = grade.verdict;
      else if (record.attempts.length === maxAttempts) record.outcome = "exhausted";
    }
    if (!await view.reveal(question, record.outcome, record.attempts.at(-1)?.grade, record.attempts.at(-1)?.answer))
      return { records, completed: false };
  }
  return { records, completed: true };
}
