import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareQuestions } from "../src/core/prepare.ts";
import type { Analyze } from "../src/core/generation.ts";
import type { Inference } from "../src/core/inference.ts";
import { mergeVocabulary } from "../src/core/vocabulary.ts";

test("standalone preparation carries accepted Japanese across ten-question batches", async () => {
  const reference = "読みました";
  const entries = mergeVocabulary([], [{ headword: reference, reading: "よみました", meaning: "read" }]);
  const tokenize: Analyze = async lines => lines.map(line => [[line, line, "動詞", false, 0, line.length]]);
  const requests: number[] = [];
  let translations = 0;
  const infer: Inference = async ({ data }) => {
    let body: object;
    if ("count" in data) {
      requests.push(Number(data.count));
      body = { sentences: [reference] };
    } else if ("sentences" in data) {
      translations++;
      body = { translations: [{ id: "1", english: "I read." }] };
    } else {
      body = { decisions: [{ id: "1", accepted: true, difficulty: "easy", grammarIds: ["polite-past"] }] };
    }
    return { text: JSON.stringify(body), stop: "stop" };
  };
  const questions = await prepareQuestions({
    entries, requested: 11, difficulty: "easy", recent: false, tokenize, infer,
    signal: new AbortController().signal, expansionPolicy: { maxPercent: 0, maxWordsPerExercise: 0 },
    catalog: {
      entries: [{ id: "polite-past", name: "Past", pattern: "ました", description: "Completed action",
        usageRules: ["Use polite past"], difficulty: "easy", enabled: true, examples: [reference] }],
      distribution: { easy: 100, medium: 0, hard: 0 }, recent: { windowDays: 1, boost: 0 },
    },
  });
  assert.deepEqual(requests, [10, 9, 9, 1, 1, 1]);
  assert.equal(translations, 1);
  assert.deepEqual(questions.map(question => question.referenceJa), [reference]);
});
