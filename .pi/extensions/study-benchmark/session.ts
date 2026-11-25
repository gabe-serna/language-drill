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

type Question = { english: string; referenceJa: string };
type StudyView = {
  answer(prompt: string): Promise<string | undefined>;
  reveal(reference: string): Promise<boolean>;
};

export async function runQuestions(questions: Question[], view: StudyView) {
  let submitted = 0;
  for (const question of questions) {
    let answer;
    do {
      answer = await view.answer(`Question ${submitted + 1}/${questions.length}\n${question.english}`);
      if (answer === undefined) return { submitted, completed: false };
    } while (!answer.trim());
    submitted++;
    if (!await view.reveal(question.referenceJa)) return { submitted, completed: false };
  }
  return { submitted, completed: true };
}
