import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addFoundationalEntry, entryKey, mergeVocabulary, readFoundationalVocabulary,
  removeFoundationalEntry, selectPracticeVocabulary, updateFoundationalEntry,
} from "./vocabulary.ts";

const metal = { headword: "金", reading: "きん", meaning: "gold" };
const money = { headword: "金", reading: "かね", meaning: "money" };
const door = { headword: "ドア", reading: "ドア", meaning: "door" };

test("authorized file edits preserve distinct entries and invalid changes leave the original intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-vocabulary-"));
  const path = join(directory, "foundational.json");
  try {
    const initial = JSON.stringify([metal, money]);
    await writeFile(path, initial);
    await assert.rejects(addFoundationalEntry(path, { ...metal, reading: "キン" }), /duplicate/);
    await assert.rejects(addFoundationalEntry(path, { ...door, reading: "" }), /reading/);
    assert.equal(await readFile(path, "utf8"), initial);
    await addFoundationalEntry(path, door);
    await updateFoundationalEntry(path, entryKey(door), { ...door, meaning: "a door" });
    await removeFoundationalEntry(path, entryKey(money));
    assert.deepEqual(await readFoundationalVocabulary(path), [metal, { ...door, meaning: "a door" }]);
    assert.deepEqual(await readdir(directory), ["foundational.json"]);
    await writeFile(path, "[{");
    await assert.rejects(addFoundationalEntry(path, door), /malformed JSON/);
    assert.equal(await readFile(path, "utf8"), "[{");
    await writeFile(path, JSON.stringify([{ ...door, meaning: 1 }]));
    await assert.rejects(readFoundationalVocabulary(path), /entry 1\.meaning/);
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

test("merged entries retain provenance and senses while examples stay outside the whitelist", () => {
  const entries = mergeVocabulary([
    { ...metal, pos: "Noun", mature: true, exampleJa: "金を溶かしました。" },
    { ...money, pos: "Noun", mature: true },
    { ...money, pos: "Noun", mature: false },
  ], [{ ...metal, reading: "キン" }, door]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0].sources, ["anki", "foundational"]);
  assert.deepEqual(entries[2].sources, ["foundational"]);
  const sample = selectPracticeVocabulary(entries, 81, new Map());
  assert.deepEqual(sample, selectPracticeVocabulary(entries, 81, new Map()));
  assert.deepEqual(sample.targets, []);
  assert.deepEqual(sample.vocabulary.map(entry => entry.headword), ["金", "金", "ドア"]);
  assert.equal(sample.vocabulary[0].exampleJa, undefined);
  assert.ok(!entries.some(entry => entry.headword === "溶かす"));
});
test("grounded adjective adds only known supporting words to the sample", async () => {
  const exampleJa = "赤い車を見ました。";
  const entries = mergeVocabulary([
    { headword: "赤い", reading: "", meaning: "red", mature: true, pos: "Adjective", exampleJa },
    { headword: "車", reading: "", meaning: "car", mature: false, pos: "Noun" },
    { headword: "見る", reading: "", meaning: "see", mature: false, pos: "Verb" },
    { headword: "可", reading: "", meaning: "permitted", mature: true, pos: "Noun", exampleJa: "学生可" },
  ], []);
  const { indexKnownExamples } = await import("./vocabulary.ts");
  const index = await indexKnownExamples(entries, { known: new Set(entries.map(entry => entry.headword)), expressions: new Map() },
    async () => [[["赤い", "赤い", "形容詞", false, 0, 2], ["車", "車", "名詞", false, 2, 3],
      ["を", "を", "助詞", false, 3, 4], ["見", "見る", "動詞", false, 4, 5],
      ["まし", "ます", "助動詞", false, 5, 7], ["た", "た", "助動詞", false, 7, 8]],
      [["学生", "学生", "名詞", false, 0, 2], ["可", "可", "名詞", false, 2, 3]]]);
  assert.equal(index.size, 1);
  const sample = selectPracticeVocabulary(entries, 81, index);
  assert.deepEqual(sample.targets, ["赤い"]);
  assert.deepEqual(sample.vocabulary.map(item => item.headword), ["赤い", "車", "見る", "可"]);
  assert.equal(sample.vocabulary[0].exampleJa, exampleJa);
  assert.equal(sample.vocabulary[3].exampleJa, undefined);
});
