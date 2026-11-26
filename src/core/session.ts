import type { Grade, Question } from "./grading.ts";

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
