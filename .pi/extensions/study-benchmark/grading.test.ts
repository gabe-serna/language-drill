import assert from "node:assert/strict";
import { test } from "node:test";
import { explainAnswer, gradeAnswer } from "./grading.ts";

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
      assert.deepEqual(data, { ...question, answer });
      assert.match(systemPrompt, /Accept equivalent vocabulary, particles/);
      assert.match(systemPrompt, /Vocabulary knowledge is unrestricted/);
      assert.match(systemPrompt, /tense, aspect/);
      return { stop: "stop", text: JSON.stringify(payload) };
    }, question, answer);
    assert.deepEqual(grade, payload);
  }
});

test("grading rejects incomplete, contradictory, and answer-revealing feedback", async () => {
  const answer = fixtures[0][0];
  for (const text of ["{", "[]", '{"verdict":"correct","feedback":"Fine","errors":["Wrong tense"]}',
    '{"verdict":"incorrect","feedback":"Wrong","errors":[]}',
    JSON.stringify({ verdict: "incorrect", feedback: question.referenceJa, errors: ["Wrong tense"] })])
    await assert.rejects(gradeAnswer(async () => ({ stop: "stop", text }), question, answer));
  await assert.rejects(gradeAnswer(async () => ({ stop: "length", text: "{}" }), question, answer), /did not finish/);
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
