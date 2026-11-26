import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/adapters/sudachi.ts";
import { cloze, runQuestions, summary } from "../src/core/session.ts";
import { formDistribution, generateTrial, buildVocabularyGate } from "../src/core/generation.ts";
import { loadGrammar } from "../src/adapters/config.ts";
import { sessionAudio } from "../src/core/audio.ts";

test("Sudachi cloze keeps requests, progressive endings and negative past", async () => {
  const rows = await analyze(["店で服を見ましたが、何も買いませんでした。", "本を読んでいますか。", "水を飲んでください。"]);
  assert.deepEqual(rows.map(cloze), ["＿＿で＿＿を＿＿ましたが、＿＿も＿＿ませんでした。", "＿＿を＿＿でいますか。", "＿＿を＿＿でください。"]);
});

test("enabled grammar admits nonpast questions and requests through the full trial", async () => {
  const sentences = ["本を読みますか。", "水を飲んでください。"];
  const gate = await buildVocabularyGate(new Set(["本", "読む", "水", "飲む"]), analyze);
  const result = await generateTrial({ size: 2, difficulty: "easy", grammarEntries: loadGrammar("data/grammar.json").entries,
    vocabulary: [], targets: [], gate, analyze, infer: async ({data}) => {
      const value = "count" in data ? { sentences } : "sentences" in data ? { translations: [
        {id:"1",english:"Do you read books?"}, {id:"2",english:"Please drink water."},
      ] } : { decisions: ["everyday-forms", "te-imperative-request"].map((id, i) =>
        ({ id: String(i+1), accepted: true, grammarIds: [id], difficulty: "easy" })) };
      return {text: JSON.stringify(value), stop:"stop"};
    } });
  assert.deepEqual(formDistribution(result.accepted), { question:1, request:1, "non-past":2, affirmative:2 });
});

test("hint toggles preserve attempts and a repeated word is confirmed only once", async () => {
  const question = { english:"I read.", referenceJa:"読みます。", difficulty:"easy" as const,
    words:[{lemma:"本",reading:"ほん",meaning:"book"}] };
  const known = new Set<string>();
  let step = 0, saved = 0, analyzed = 0;
  const result = await runQuestions([question, question], {
    known, async analyze(lines) { analyzed++; return analyze(lines); },
    async answer({ hint, remaining }) {
      assert.equal(remaining, 3);
      if (++step === 1) return { action:"hint" };
      if (step === 2) { assert.ok(hint); return {action:"hint"}; }
      assert.equal(hint, "");
      return step === 3 ? {action:"submit",answer:"読む"} : {action:"give_up"};
    },
    async grade() { return {verdict:"correct",feedback:"Good",errors:[]}; },
    async reveal() { return true; }, async confirm() { return "yes"; }, async save() { saved++; },
  });
  assert.equal(analyzed, 1);
  assert.equal(saved, 1);
  assert.ok(known.has("本"));
  const report = summary(result);
  for (const text of ["Completed 2/2","Correct first try 1","Surrendered 1","accuracy 100%","with hints 1","easy 1/2","New vocabulary: 本"])
    assert.ok(report.includes(text), report);
});

test("slow synthesis is lazy, cached separately and cancelled by navigation", async () => {
  const calls: boolean[] = [];
  const plays: AbortSignal[] = [];
  const session = sessionAudio(async (_text, _signal, slow) => {
    calls.push(!!slow); return Buffer.from("RIFF0000WAVE");
  }, async (_audio, signal) => {
    plays.push(signal);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once:true}));
  });
  session.preload("文");
  assert.deepEqual(calls,[false]);
  for (const slow of [false,true,true,false]) {
    session.replay("文", assert.fail, slow);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(plays.slice(0,-1).every(signal => signal.aborted));
  }
  await session.close();
  assert.equal(plays.length,4);
  assert.deepEqual(calls,[false,true]);
  assert.ok(plays.every(signal => signal.aborted));
});
