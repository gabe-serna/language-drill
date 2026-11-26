import assert from "node:assert/strict";
import { test } from "node:test";
import { explainAnswer, gradeAnswer } from "../src/core/grading.ts";
import { runQuestions } from "../src/core/session.ts";
import { requestInference } from "../src/core/inference.ts";

test("provider contract rejects invalid token budgets and malformed reply envelopes", async () => {
  const request = { systemPrompt: "Grade", data: {}, maxTokens: 1 };
  await assert.rejects(requestInference(async () => assert.fail("unexpected inference"), { ...request, maxTokens: 0 }), /Invalid inference request/);
  await assert.rejects(requestInference(async () => ({ text: "{}", stop: "" }), request), /Invalid inference response/);
});

const question = { english: "I was reading a book at home.", referenceJa: "家で本を読んでいました。" };
const fixtures = [
  ["自宅で読書をしていました。", "correct", []],
  ["私は家で本を読んでいた。", "correct", []],
  ["家に本を読んでいました。", "partially_correct", ["The location particle is unsuitable for where the action took place."]],
  ["家で本を読みました。", "partially_correct", ["The answer omits the ongoing aspect."]],
  ["家で本を読んでいます。", "partially_correct", ["The answer places the ongoing action in the present."]],
  ["家でテレビを見ていました。", "incorrect", ["The answer describes watching television instead of reading."]],
] as const;

test("grading sends only the current exercise and accepts structured verdicts for varied answer cases", async () => {
  for (const [answer, verdict, errors] of fixtures) {
    const payload = { verdict, feedback: "Feedback on this attempt.", errors };
    const grade = await gradeAnswer(async ({ systemPrompt, data }) => {
      assert.deepEqual(data, { ...question, answer, attemptsRemainingAfterSubmission: 2 });
      assert.match(systemPrompt, /Accept equivalent vocabulary, particles/);
      assert.match(systemPrompt, /Vocabulary knowledge is unrestricted/);
      assert.match(systemPrompt, /tense, aspect/);
      return { stop: "stop", text: JSON.stringify(payload) };
    }, question, answer);
    assert.deepEqual(grade, payload);
  }
});

test("grading rejects incomplete and contradictory structured feedback", async () => {
  const answer = fixtures[0][0];
  for (const text of ["{", "[]", '{"verdict":"correct","feedback":"Fine","errors":["Wrong tense"]}',
    '{"verdict":"incorrect","feedback":"Wrong","errors":[]}'])
    await assert.rejects(gradeAnswer(async () => ({ stop: "stop", text }), question, answer));
  await assert.rejects(gradeAnswer(async () => ({ stop: "length", text: "{}" }), question, answer), /did not finish/);
});

test("Japanese corrective feedback counts as an evaluated attempt and partial credit completes the question", async () => {
  const wrong = {
    verdict: "incorrect",
    feedback: "Use 本 for a book, and use で for where the reading took place.",
    errors: ["テレビを見ました describes watching TV. Use the past progressive 読んでいました for the ongoing action."],
  };
  const partial = {
    verdict: "partially_correct",
    feedback: "家で本を読みました captures the action, but 読みました leaves out the ongoing aspect.",
    errors: ["Use 本を読んでいました to express that the reading was in progress."],
  };
  const replies = [wrong, partial];
  const submissions = ["家にテレビを見ました。", "家で本を読みました。"];
  const attempted = [2, 1];
  let entries = 0;
  const result = await runQuestions([question], {
    async answer({ attempts, failure }) {
      assert.equal(failure, "");
      assert.equal(attempts.length, entries);
      assert.ok(entries < submissions.length, "a partially correct answer should end the question");
      if (entries === 1) assert.deepEqual(attempts[0].grade, wrong);
      return { action: "submit", answer: submissions[entries++] };
    },
    grade(item, answer, remaining) {
      return gradeAnswer(async ({ systemPrompt, data }) => {
        assert.equal(remaining, attempted.shift());
        assert.deepEqual(data, { ...question, answer, attemptsRemainingAfterSubmission: remaining });
        assert.match(systemPrompt, /withholding the complete reference translation/);
        return { stop: "stop", text: JSON.stringify(replies.shift()) };
      }, item, answer, remaining);
    },
    async reveal(item, outcome, grade, answer) {
      assert.equal(item.referenceJa, question.referenceJa);
      assert.equal(outcome, "partially_correct");
      assert.deepEqual(grade, partial);
      assert.equal(answer, submissions[1]);
      return true;
    },
  });
  assert.equal(result.completed, true);
  assert.equal(result.records[0].attempts.length, 2);
});

test("reference explanation uses an isolated payload without the learner's answers", async () => {
  const points = ["The location particle marks where the action took place."];
  assert.deepEqual(await explainAnswer(async ({ data }) => {
    assert.deepEqual(data, question);
    return { stop: "stop", text: JSON.stringify({ points }) };
  }, { ...question, answer: "private draft" } as typeof question), points);
  await assert.rejects(explainAnswer(async () => ({ stop: "stop", text: '{"points":[]}' }), question));
});
test("correct feedback can quote a useful particle and grading distinguishes truncation from invalid JSON", async () => {
  const body = { verdict: "correct", feedback: "に is also natural here.", errors: [] };
  assert.deepEqual(await gradeAnswer(async () => ({ stop: "stop", text: JSON.stringify(body) }), question, fixtures[0][0]), body);
  for (const [stop, text, reason] of [["length", "", /length/], ["stop", "", /Empty/], ["stop", "{", /Malformed/]] as const)
    await assert.rejects(gradeAnswer(async () => ({ stop, text }), question, fixtures[0][0]), reason);
});
