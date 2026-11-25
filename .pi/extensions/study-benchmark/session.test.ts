import assert from "node:assert/strict";
import { test } from "node:test";
import { runQuestions, studyCommand, studyCompletions } from "./session.ts";

test("study menu, count, and completion", () => {
  assert.equal(studyCommand(""), undefined);
  assert.equal(studyCommand("drilling"), 10);
  assert.equal(studyCommand("drilling --q 12"), 12);
  for (const args of ["unknown", "drilling --q", "drilling --q 0", "drilling --q 1.5", "drilling --q 3 extra"])
    assert.throws(() => studyCommand(args), /positive integer/);
  assert.equal(studyCompletions("drilling --")?.[0].value, "drilling --q");
});

const question = { english: "I went to school.", referenceJa: "学校へ行きました。" };
const wrong = { verdict: "incorrect", feedback: "The action differs.", errors: ["This says you left the school."] } as const;

test("only evaluated submissions count, drafts survive failures, and reveal follows the third attempt", async () => {
  let submissions = 0;
  let grading = 0;
  let revealed = false;
  const result = await runQuestions([question], {
    async answer({ draft, attempts, prompt, gradingFailed }) {
      assert.match(prompt, /1\/1\nI went to school/);
      assert.equal(revealed, false);
      assert.equal(draft, submissions ? "学校を出ました。" : "");
      if (submissions === 1 || submissions === 2) {
        assert.equal(gradingFailed, true);
        assert.equal(attempts.length, 0);
      }
      submissions++;
      return { action: "submit", answer: "学校を出ました。" };
    },
    async grade() {
      if (++grading === 1) throw Error("malformed JSON");
      if (grading === 2) throw new DOMException("Cancelled", "AbortError");
      return { ...wrong, errors: [...wrong.errors] };
    },
    async reveal(item, outcome) {
      assert.equal(item.referenceJa, question.referenceJa);
      assert.equal(outcome, "exhausted");
      assert.equal(grading, 5);
      revealed = true;
      return true;
    },
  });
  assert.equal(result.records[0].attempts.length, 3);
  assert.equal(result.completed, true);
});

test("give up reveals immediately, correct advances, and exit leaves the next reference hidden", async () => {
  const outcomes: string[] = [];
  const result = await runQuestions([question, question, question], {
    async answer({ prompt }) {
      if (prompt.startsWith("Question 1/")) return { action: "give_up" };
      if (prompt.startsWith("Question 2/")) return { action: "submit", answer: "学校に行きました。" };
      return { action: "exit" };
    },
    async grade() { return { verdict: "correct", feedback: "Meaning matches.", errors: [] }; },
    async reveal(_question, outcome) { outcomes.push(outcome); return true; },
  });
  assert.deepEqual(outcomes, ["gave_up", "correct"]);
  assert.deepEqual(result.records.map(record => record.attempts.length), [0, 1, 0]);
  assert.equal(result.completed, false);
});
