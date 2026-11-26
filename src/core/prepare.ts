import { allocate, shuffle, type Difficulty, type GrammarCatalog } from "./grammar.ts";
import { buildVocabularyGate, finalizeExpansion, generateTrial, type AcceptedExercise, type Analyze, type ExpansionPolicy, type Stage } from "./generation.ts";
import { indexKnownExamples, selectPracticeVocabulary, type VocabularyEntry } from "./vocabulary.ts";
import type { Inference } from "./inference.ts";

type Preparation = {
  entries: VocabularyEntry[];
  catalog: GrammarCatalog;
  requested: number;
  difficulty?: Difficulty;
  recent: boolean;
  expansionPolicy: ExpansionPolicy;
  tokenize: Analyze;
  infer: Inference;
  signal: AbortSignal;
  onProgress?: (prepared: number, difficulty: Difficulty, stage: Stage, attempt: number) => void;
};

export async function prepareQuestions({ entries, catalog, requested, difficulty, recent, expansionPolicy,
  tokenize, infer, signal, onProgress }: Preparation) {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("Invalid question count.");
  const gate = await buildVocabularyGate(new Set(entries.map(item => item.headword)), tokenize);
  const examples = await indexKnownExamples(entries, gate, tokenize);
  const accepted: AcceptedExercise[] = [];
  const deferred: AcceptedExercise[] = [];
  const seed = Date.now();
  for (const tier of allocate(requested, catalog.distribution, difficulty)) {
    for (let remaining = tier.count; remaining > 0;) {
      signal.throwIfAborted();
      const size = Math.min(10, remaining);
      const sample = selectPracticeVocabulary(entries, seed + accepted.length, examples, recent ? catalog.recent : undefined);
      const result = await generateTrial({ ...sample, size, difficulty: tier.difficulty, grammarEntries: catalog.entries,
        previous: [...accepted, ...deferred], gate, analyze: tokenize, expansionPolicy, infer, onCall(stage, attempt) {
          signal.throwIfAborted();
          onProgress?.(accepted.length, tier.difficulty, stage, attempt);
        } });
      accepted.push(...result.accepted);
      deferred.push(...result.pending);
      remaining -= size;
    }
  }
  signal.throwIfAborted();
  const questions = finalizeExpansion(accepted, deferred, expansionPolicy.maxPercent, requested);
  return difficulty ? questions : shuffle(questions);
}
