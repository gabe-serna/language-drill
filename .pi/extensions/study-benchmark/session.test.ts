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

test("blank drafts retry, references require submission, and exit stops progression", async () => {
  const drafts = [" ", "答え"];
  const questions = [{ english: "Prompt", referenceJa: "参考" }];
  let shown = 0;
  assert.deepEqual(await runQuestions(questions, {
    async answer(title) { assert.match(title, /1\/1/); return drafts.shift(); },
    async reveal(reference) { assert.equal(reference, "参考"); shown++; return true; },
  }), { submitted: 1, completed: true });
  assert.equal(shown, 1);
  assert.deepEqual(await runQuestions(questions, {
    async answer() { return undefined; }, async reveal() { throw Error("unexpected reveal"); },
  }), { submitted: 0, completed: false });
});
