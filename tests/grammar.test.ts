import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGrammar } from "../src/adapters/config.ts";
import { allocate } from "../src/core/grammar.ts";
import { recencyWeight, mergeVocabulary, selectPracticeVocabulary } from "../src/core/vocabulary.ts";
import { studyCommand, studyCompletions } from "../.pi/extensions/study-benchmark/commands.ts";
import { finalizeExpansion, validateBatch, type AcceptedExercise } from "../src/core/generation.ts";

const path = "data/grammar.json";
const config = loadGrammar(path);

test("whole question allocation is stable and keeps explicit tiers", () => {
  assert.deepEqual(allocate(10, config.distribution).map(x => x.count), [5,3,2]);
  assert.deepEqual(allocate(5, config.distribution).map(x => x.count), [3,1,1]);
  assert.deepEqual(allocate(20, config.distribution, "hard"), [{difficulty:"hard",count:20}]);
});

test("grammar inventory rejects duplicate IDs and invalid percentages", () => {
  assert.ok(config.entries.every(entry => entry.enabled));
  const dir = mkdtempSync(join(tmpdir(), "study-grammar-"));
  const file = join(dir, "config.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    writeFileSync(file, JSON.stringify({...raw, distribution:{easy:80,medium:30,hard:20}}));
    assert.throws(() => loadGrammar(file), /totaling 100/);
    raw.entries.push(raw.entries[0]);
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => loadGrammar(file), /unique IDs/);
  } finally { rmSync(file); rmdirSync(dir); }
});

test("recency weighting decays and does not depend on maturity", () => {
  const now = 2_000_000_000_000;
  const recent = {windowDays:30, boost:4};
  assert.equal(recencyWeight(now, recent, now),5);
  assert.equal(recencyWeight(now - 15 * 86400000, recent, now),3);
  assert.equal(recencyWeight(now - 31 * 86400000, recent, now),1);
  const make = (mature: boolean) => mergeVocabulary(Array.from({length:70}, (_,i) => ({
    headword: "noun"+i, reading:"", meaning:"", pos:"Noun",
    mature: i === 0 ? mature : true, reviewedAt: i === 0 ? now : undefined,
  })), []);
  let recentHits = 0;
  let unweightedHits = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const sample = (mature: boolean, boost: number) => selectPracticeVocabulary(make(mature), seed, new Map(), { ...recent, boost }, now);
    assert.deepEqual(sample(true,4), sample(false,4));
    if (sample(false,4).vocabulary.some(word => word.headword === "noun0")) recentHits++;
    if (sample(false,0).vocabulary.some(word => word.headword === "noun0")) unweightedHits++;
  }
  assert.ok(recentHits > unweightedHits);
});

test("drill flags work in either order and autocomplete validates difficulties", () => {
  const settings = {count:5,difficulty:"medium",recent:true};
  assert.deepEqual(studyCommand("drilling --difficulty medium --q 5 --recent"),settings);
  assert.deepEqual(studyCommand("drilling --recent --q 5 --difficulty medium"),settings);
  assert.throws(() => studyCommand("drilling --difficulty mixed"));
  assert.throws(() => studyCommand("drilling --recent --recent"));
  assert.equal(studyCompletions("drilling --difficulty m")?.[0].value,"drilling --difficulty medium");
});

test("difficulty review requires a matching tier and enabled grammar IDs", async () => {
  const grammar = { difficulty:"medium" as const, entries:config.entries, targets:["polite-past"] };
  const item = {id:"1",referenceJa:"家で本を読みました。",english:"I read a book at home.",targetGrammarId:"polite-past"};
  for (const [difficulty, grammarIds, accepted] of [
    ["medium",["polite-past"],true], ["easy",["polite-past"],false], ["medium",["polite-past","disabled"],false],
  ] as const) {
    const review = await validateBatch([item], async ({ data }) => {
      assert.ok("grammar" in data);
      return {stop:"stop",text:JSON.stringify({decisions:[{id:"1",accepted:true,difficulty,grammarIds}]})};
    }, undefined, grammar);
    assert.equal(review.decisions.get("1")?.accepted, accepted);
  }
});

test("mixed sessions can spend expansion budget across tiers without exceeding it", () => {
  const known = Array.from({length:8}, (_,id) => ({id:String(id),difficulty:"easy"} as AcceptedExercise));
  const pending = Array.from({length:3}, (_,id) => ({
    id: String(id + 8), difficulty:"hard", words:[{lemma:"茶",reading:"ちゃ",meaning:"tea"}],
  } as AcceptedExercise));
  const exercises = finalizeExpansion(known, pending, 20, 10);
  assert.equal(exercises.length,10);
  assert.equal(exercises.filter(item => item.difficulty === "hard").length,2);
  assert.equal(finalizeExpansion(known.slice(0,3),pending,20,10).length,3);
});
