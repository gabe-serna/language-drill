import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildVocabularyGate, coverage, generateTrial, politePastVerb, translateBatch, validateBatch, type Inference, type ReviewExercise, type Token } from "./generation.ts";
import { validatorCases } from "./validator-cases.ts";

const reply = (body: unknown) => ({ text: JSON.stringify(body), stop: "stop" });

test("invalid reviewer output cannot approve even a valid subset", async () => {
  const exercises = validatorCases.slice(0, 2).map(({ exercise }) => exercise);
  const good = { id: exercises[0].id, accepted: true, reason: "" };
  for (const decisions of [
    [good], [good, good], [good, { ...good, id: "unexpected" }],
    [good, { id: exercises[1].id, accepted: "true", reason: "" }],
    [good, { id: exercises[1].id, accepted: false, reason: " " }],
  ]) {
    const result = await validateBatch(exercises, async () => reply({ decisions }));
    assert.ok(result.error);
    assert.equal(result.decisions.size, 0);
  }
  for (const response of [{ text: "{", stop: "stop" }, { ...reply({ decisions: [] }), stop: "length" }]) {
    const result = await validateBatch(exercises, async () => response);
    assert.ok(result.error);
    assert.equal(result.decisions.size, 0);
  }
});

test("one JSON-only Markdown fence accepts a matching numeric ID and a reasonless approval", async () => {
  const { exercise } = validatorCases[0];
  const body = JSON.stringify({ decisions: [{ id: Number(exercise.id), accepted: true }] });
  const fenced = ["```json", body, "```"].join("\n");
  const valid = await validateBatch([exercise], async () => ({ text: fenced, stop: "stop" }));
  assert.equal(valid.decisions.get(exercise.id)?.accepted, true);
  const invalid = await validateBatch([exercise], async () => ({ text: "Review:\n" + fenced, stop: "stop" }));
  assert.equal(invalid.decisions.size, 0);
});

test("translation gets only Japanese and IDs and rejects incomplete or rewritten responses", async () => {
  const exercise = validatorCases[0].exercise;
  const expected = { id: exercise.id, referenceJa: exercise.referenceJa };
  const result = await translateBatch([exercise], async ({ data }) => {
    assert.deepEqual(data, { sentences: [expected] });
    return reply({ translations: [{ id: 1, english: "I read a book." }] });
  });
  assert.equal(result.translations.get(exercise.id), "I read a book.");
  for (const translations of [[], [{ id: "wrong", english: "I read a book." }],
    [{ ...expected, english: "I read a book." }], [{ id: exercise.id, english: "本" }]]) {
    const invalid = await translateBatch([exercise], async () => reply({ translations }));
    assert.ok(invalid.error);
    assert.equal(invalid.translations.size, 0);
  }
});

const simpleAnalysis = async (lines: string[]): Promise<Token[][]> =>
  lines.map(text => [[text, text, "名詞", false, 0, text.length]]);
const item = (id: string, referenceJa: string) => ({ id, referenceJa, targetGrammarId: "polite-past" });

test("each refill follows Japanese gate, translation, and review with isolated payloads", async () => {
  const a = item("1", "本を読みました。");
  const wrong = item("2", "水を飲みました。");
  const unknown = item("3", "未知語を買いました。");
  const b = item("2", "手紙を書きました。");
  const c = item("1", "車を見ました。");
  const stages: string[] = [];
  const prompts = new Set<string>();
  const batches = [[{ ...a, id: 1 }, wrong, unknown], [{ ...wrong, id: "1" }, b], [c]];
  let generated = 0;
  let reviewed = 0;
  const infer: Inference = async ({ systemPrompt, data }) => {
    prompts.add(systemPrompt);
    if ("count" in data) {
      if (generated === 1) {
        assert.deepEqual((data as { priorRejected: {referenceJa: string}[] }).priorRejected.map(item => item.referenceJa),
          [unknown.referenceJa, wrong.referenceJa]);
        assert.deepEqual((data as { priorAccepted: string[] }).priorAccepted, [a.referenceJa]);
      }
      return reply({ sentences: batches[generated++].map(item => item.referenceJa) });
    }
    if ("sentences" in data) {
      assert.deepEqual(Object.keys(data), ["sentences"]);
      const sentences = data.sentences as { id: string; referenceJa: string }[];
      assert.deepEqual(sentences.map(item => item.referenceJa), [
        [a.referenceJa, wrong.referenceJa], [b.referenceJa], [c.referenceJa],
      ][generated - 1]);
      for (const sentence of sentences) assert.deepEqual(Object.keys(sentence), ["id", "referenceJa"]);
      return reply({ translations: sentences.map(sentence => ({
        id: sentence.id, english: sentence.referenceJa === wrong.referenceJa ? "I bought water." : "English " + sentence.id,
      })) });
    }
    assert.deepEqual(Object.keys(data), ["exercises"]);
    const exercises = (data as { exercises: ReviewExercise[] }).exercises;
    assert.equal(exercises.length, generated === 1 ? 2 : 1);
    for (const exercise of exercises) assert.deepEqual(Object.keys(exercise), ["id", "referenceJa", "english", "targetGrammarId"]);
    if (++reviewed === 3) return reply({ decisions: [] });
    return reply({ decisions: exercises.map(({ id, english }) => ({
      id, accepted: english !== "I bought water.", reason: english === "I bought water." ? "Bought and drank differ." : "",
    })) });
  };
  const result = await generateTrial({
    vocabulary: [], targets: [a.referenceJa], analyze: simpleAnalysis,
    gate: { known: new Set([a, wrong, b, c].map(item => item.referenceJa)), expressions: new Map() },
    infer, onCall: stage => stages.push(stage),
  });
  assert.equal(prompts.size, 3);
  assert.deepEqual(stages, Array.from({ length: 3 }, () => ["generation", "translation", "validation"]).flat());
  assert.deepEqual(result.accepted.map(item => item.referenceJa), [a.referenceJa, b.referenceJa]);
  assert.equal(result.uniqueVocabulary, 2);
  assert.equal(result.targetUses[a.referenceJa], 1);
  assert.equal(result.calls[1].deterministicRejections["duplicate Japanese"], 1);
  assert.equal(result.calls[2].aiRejections["review unavailable: invalid decision count"], 1);
});

test("translation failure withholds the batch and duplicate refills skip both downstream stages", async () => {
  const a = item("1", "本を読みました。");
  const stages: string[] = [];
  const result = await generateTrial({
    vocabulary: [], targets: [], analyze: simpleAnalysis,
    gate: { known: new Set([a.referenceJa]), expressions: new Map() },
    onCall: stage => stages.push(stage),
    infer: async ({ data }) => "count" in data ? reply({ sentences: [a.referenceJa] }) : reply({ translations: [] }),
  });
  assert.deepEqual(stages, ["generation", "translation", "generation", "generation"]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.calls[0].translationRejections["translation unavailable: invalid translation count"], 1);
  assert.equal(result.calls[2].deterministicRejections["duplicate Japanese"], 1);
});

test("known inflections and exact fixed expressions pass without licensing their unknown parts", async () => {
  const terminal: Token = ["まし", "ます", "助動詞", false, 2, 4];
  const inflected = (surface: string, lemma: string): Token[] =>
    [[surface, lemma, "動詞", false, 0, 2], terminal, ["た", "た", "助動詞", false, 4, 5]];
  const phrase: Token[] = [["気", "気", "名詞", false, 0, 1], ["を", "を", "助詞", false, 1, 2],
    ["つけて", "つける", "動詞", false, 2, 5]];
  const gate = await buildVocabularyGate(new Set(["読む", "来る", "気をつけて"]), async () =>
    [[["読む", "読む", "動詞", false, 0, 2]], [["来る", "来る", "動詞", false, 0, 2]], phrase]);
  assert.deepEqual(coverage("読みました", inflected("読み", "読む"), gate), { unknown: [], used: ["読む"] });
  assert.deepEqual(coverage("気をつけて", phrase, gate), { unknown: [], used: ["気をつけて"] });
  assert.deepEqual(coverage("気", phrase.slice(0, 1), gate).unknown, ["気"]);
  assert.deepEqual(coverage("きました", [["き", "くる", "動詞", false, 0, 1],
    ["まし", "ます", "助動詞", false, 1, 3], ["た", "た", "助動詞", false, 3, 4]], gate).unknown, ["き"]);
});

const analyze = async (lines: string[]): Promise<Token[][]> => {
  const python = fileURLToPath(new URL("../../../.venv/Scripts/python.exe", import.meta.url));
  const script = fileURLToPath(new URL("./analyze.py", import.meta.url));
  const result = spawnSync(python, [script], {
    input: JSON.stringify(lines), encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};

test("pinned Sudachi distinguishes conjugated lemmas, alternate spellings and fixed expressions", async () => {
  const gate = await buildVocabularyGate(new Set(["来る", "探す", "気をつけて"]), analyze);
  const lines = ["来ました。", "探しませんでした。", "気をつけて", "気", "きました。", "さがしました。", "着ました。"];
  const results = (await analyze(lines)).map((tokens, i) => coverage(lines[i], tokens, gate).unknown);
  assert.deepEqual(results, [[], [], [], ["気"], ["き"], ["さがし"], ["着"]]);
});

test("decimal-ID trace regression, string-only refill and stable downstream identity", async () => {
  const sentence = "電気をつけました。";
  const old = { items: [{ id: "0.3", referenceJa: sentence, targetGrammarId: "polite-past" }] };
  const diagnostics: string[] = [];
  let attempt = 0;
  const result = await generateTrial({
    vocabulary: [], targets: [sentence], analyze: simpleAnalysis,
    gate: { known: new Set([sentence]), expressions: new Map() },
    report: message => diagnostics.push(message),
    infer: async ({ data }) => {
      if ("count" in data) {
        attempt++;
        if (attempt === 1) return reply(old);
        if (attempt === 2) {
          assert.ok("formatFeedback" in data);
          return reply({ sentences: [42, sentence, "緑が綺麗でした。"] });
        }
        assert.deepEqual((data as { preferredTargets: string[] }).preferredTargets, []);
        assert.match(JSON.stringify((data as { priorRejected: unknown[] }).priorRejected), /polite-past verb/);
        return { text: "{", stop: "length" };
      }
      if ("sentences" in data) {
        assert.deepEqual(data.sentences, [{ id: "12", referenceJa: sentence }]);
        return reply({ translations: [{ id: "12", english: "I turned on the light." }] });
      }
      assert.deepEqual((data as { exercises: ReviewExercise[] }).exercises, [{ id: "12", referenceJa: sentence, targetGrammarId: "polite-past", english: "I turned on the light." }]);
      return reply({ decisions: [{ id: "12", accepted: true }] });
    },
  });
  assert.deepEqual(result.accepted.map(item => item.id), ["12"]);
  assert.match(diagnostics[0], /\$\.sentences.*expected array.*received <missing>/);
  assert.match(diagnostics[1], /sentences\[0\].*expected nonblank string.*received 42/);
  assert.match(diagnostics[2], /stopReason.*length.*truncated/);
  const malformed: string[] = [];
  await translateBatch([], async () => ({ text: "{", stop: "stop" }), message => malformed.push(message));
  assert.match(malformed[0], /expected valid JSON.*received/);
});

test("refills abandon repeatedly implicated targets and flag repeated templates without excluding valid exercises", async () => {
  const bad1 = "明日学校へ行きました。";
  const bad2 = "明日、本を読みました。";
  const good1 = "本を読みました。";
  const good2 = "新聞を読みました。";
  const good3 = "明日行くと決めました。";
  const good4 = "車が動きました。";
  const good5 = "昨日、本を読みました。";
  const good6 = "昨日は本を読みました。";
  const gate = await buildVocabularyGate(new Set(["明日", "学校", "行く", "本", "読む", "新聞", "決める", "車", "動く", "昨日"]), analyze);
  const batches = [[bad1, good1, good2], [bad2], [good1, good3, good4, good5, good6]];
  const translations = new Map([
    [bad1, "I went to school tomorrow."], [bad2, "I read a book tomorrow."],
    [good1, "I read a book."], [good2, "I read the newspaper."],
    [good3, "I decided to go tomorrow."], [good4, "The car moved."],
    [good5, "Yesterday I read a book."], [good6, "As for yesterday, I read a book."],
  ]);
  let attempt = 0;
  const result = await generateTrial({
    vocabulary: [], targets: ["明日", "動く", "読む"], gate, analyze,
    infer: async ({ data }) => {
      if ("count" in data) {
        const input = data as { preferredTargets: string[]; diversity?: { repeatedContent: unknown; repeatedMainVerbs: unknown } };
        if (attempt === 1) {
          assert.deepEqual(input.preferredTargets, ["動く", "明日"]);
          assert.deepEqual(input.diversity?.repeatedContent, [["読む", 2]]);
          assert.deepEqual(input.diversity?.repeatedMainVerbs, [["読む", 2]]);
        }
        if (attempt === 2) assert.deepEqual(input.preferredTargets, ["動く"]);
        return reply({ sentences: batches[attempt++] });
      }
      if ("sentences" in data) {
        const sentences = data.sentences as { id: string; referenceJa: string }[];
        assert.ok(sentences.every(item => !("verifiedPolitePastVerb" in item)));
        return reply({ translations: sentences.map(item => ({ id: item.id, english: translations.get(item.referenceJa) })) });
      }
      const { exercises } = data as { exercises: ReviewExercise[] };
      assert.ok(exercises.every(item => item.verifiedPolitePastVerb));
      return reply({ decisions: exercises.map(item => item.referenceJa === bad1 || item.referenceJa === bad2
        ? { id: item.id, accepted: false, reason: "Tomorrow conflicts with the completed action.", problemWords: ["明日"] }
        : { id: item.id, accepted: true }) });
    },
  });
  assert.deepEqual(result.accepted.map(item => item.referenceJa), [good1, good2, good3, good4, good5, good6]);
  assert.equal(result.calls[0].nearDuplicates, 1);
  assert.equal(result.calls[2].deterministicRejections["duplicate Japanese"], 1);
  assert.equal(result.calls[2].nearDuplicates, 2);
  assert.equal(result.usage.uniqueMainVerbs, 3);
  assert.deepEqual(result.targetUses, { 明日: 1, 動く: 1, 読む: 4 });
  assert.deepEqual(result.abandonedTargets, [["明日", {
    attempt: 3, reasons: ["Tomorrow conflicts with the completed action.", "Tomorrow conflicts with the completed action."],
  }]]);
});

test("malformed review and translation timeout leave preferred targets eligible", async () => {
  const batches = ["明日学校へ行きました。", "明日、本を読みました。"];
  const gate = await buildVocabularyGate(new Set(["明日", "学校", "行く", "本", "読む"]), analyze);
  let attempt = 0;
  const result = await generateTrial({
    vocabulary: [], targets: ["明日"], gate, analyze,
    infer: async ({ data }) => {
      if ("count" in data) {
        assert.deepEqual((data as { preferredTargets: string[] }).preferredTargets, ["明日"]);
        const sentence = batches[attempt++];
        return reply({ sentences: sentence ? [sentence] : [] });
      }
      if ("sentences" in data) {
        if (attempt === 2) return { text: "", stop: "aborted" };
        return reply({ translations: [{ id: "1", english: "I went to school tomorrow." }] });
      }
      return reply({ decisions: [{ id: "1", accepted: "false", reason: "Time conflict.", problemWords: ["明日"] }] });
    },
  });
  assert.deepEqual(result.abandonedTargets, []);
  assert.equal(result.accepted.length, 0);
});

test("Sudachi corroborates polite-past motion and decisions about future plans", async () => {
  const lines = ["車が動きました。", "明日行くと決めました。", "学校へ行きませんでした。", "静かでした。", "今動きます。"];
  assert.deepEqual((await analyze(lines)).map(tokens => politePastVerb(tokens)?.[0]),
    ["動き", "決め", "行き", undefined, undefined]);
});
test("expansion waits for known-only refills and enforces the actual partial-batch percentage", async () => {
  const known = ["水", "飲む", "本", "読む", "車", "見る", "家", "出る"];
  const gate = await buildVocabularyGate(new Set(known), analyze);
  const batches = [["茶を飲みました。", "新聞を読みました。", "雑誌を買いました。"],
    ["水を飲みました。", "本を読みました。", "車を見ました。", "家を出ました。"], []];
  let attempt = 0;
  const result = await generateTrial({ vocabulary: [], targets: [], gate, analyze, infer: async ({ data }) => {
    if ("count" in data) return reply({ sentences: batches[attempt++] });
    if ("sentences" in data) return reply({ translations: (data.sentences as {id: string}[]).map(({id}) => ({ id, english: "Sentence " + id })) });
    const exercises = (data as {exercises: ReviewExercise[]}).exercises;
    return reply({ decisions: exercises.map(({id, unconfirmedLemmas}) => ({
      id, accepted: true, words: unconfirmedLemmas?.map(lemma => lemma === "茶"
        ? {lemma, reading:"ちゃ", meaning:"tea"} : {lemma, reading:"しんぶん", meaning:"newspaper"}),
    })) });
  } });
  assert.equal(result.accepted.length, 5);
  assert.deepEqual(result.accepted.flatMap(item => item.words ?? []), [{lemma:"茶",reading:"ちゃ",meaning:"tea"}]);
  assert.equal(result.expansionLimitRejections, 1);
  assert.equal(result.calls[0].deterministicRejections["vocabulary expansion limit per exercise"], 1);
});
