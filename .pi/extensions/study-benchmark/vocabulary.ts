import { coverage, type VocabularyGate, type Token } from "./generation.ts";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";

export type Entry = { headword: string; reading: string; meaning: string };
export type AnkiEntry = Entry & { pos: string; mature: boolean; exampleJa?: string };
type VocabularyEntry = Entry & {
  sources: ("anki" | "foundational")[];
  pos?: string;
  mature?: boolean;
  exampleJa?: string;
};

function normalize(value: string) {
  return value.normalize("NFC").trim();
}

function entry(value: unknown, label: string): Entry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object with headword, reading and meaning`);
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["headword", "reading", "meaning"].includes(key))) {
    throw new Error(`${label}: only headword, reading and meaning are supported`);
  }
  const get = (key: keyof Entry) => {
    const raw = fields[key];
    if (typeof raw !== "string" || /[<>\p{Cc}\p{Cf}]/u.test(raw)) {
      throw new Error(`${label}.${key}: expected plain text on one line`);
    }
    const text = normalize(raw);
    if (!text || text.length > (key === "meaning" ? 240 : 80)) {
      throw new Error(`${label}.${key}: expected nonempty, bounded text`);
    }
    return text;
  };
  const headword = get("headword");
  const reading = get("reading");
  const meaning = get("meaning");
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(headword)
      || !/^[\p{Script=Hiragana}\p{Script=Katakana}ー・ 　]+$/u.test(reading)) {
    throw new Error(`${label}: headword must contain Japanese and reading must be in kana`);
  }
  return { headword, reading, meaning };
}

export function entryKey({ headword, reading, meaning }: Entry) {
  const kana = normalize(reading).replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
  return JSON.stringify([normalize(headword), kana, normalize(meaning).toLowerCase().replace(/\s+/g, " ")]);
}

function parseEntries(value: unknown, path: string): Entry[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected a JSON array`);
  const seen = new Set<string>();
  return value.map((value, index) => {
    const label = `${path}, entry ${index + 1}`;
    const parsed = entry(value, label);
    const key = entryKey(parsed);
    if (seen.has(key)) throw new Error(`${label}: duplicate headword, reading and meaning`);
    seen.add(key);
    return parsed;
  });
}

function decode(text: string, path: string) {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`${path}: malformed JSON (${(error as Error).message})`); }
  return parseEntries(data, path);
}

export async function readFoundationalVocabulary(path: string) {
  const text = await readFile(path, "utf8").catch(error => {
    throw new Error(`${path}: could not read foundational vocabulary (${error.code ?? error.message})`);
  });
  return decode(text, path);
}

async function edit(path: string, change: (entries: Entry[]) => Entry[]) {
  const lockPath = path + ".lock";
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error(`${path}: another vocabulary edit is in progress`);
    throw error;
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const before = await readFile(path, "utf8");
    const entries = parseEntries(change(decode(before, path)), path);
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(JSON.stringify(entries, null, 2) + "\n", "utf8");
      await file.sync();
    } finally { await file.close(); }
    if (await readFile(path, "utf8") !== before) throw new Error(`${path}: changed on disk during the edit`);
    await rename(temporary, path);
    return entries;
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

// Call these only when applying an explicit user edit or approval.
export function addFoundationalEntry(path: string, value: Entry) {
  return edit(path, entries => [...entries, value]);
}

function findEntry(entries: Entry[], key: string) {
  const index = entries.findIndex(value => entryKey(value) === key);
  if (index < 0) throw new Error("Foundational vocabulary entry no longer exists");
  return index;
}

export function updateFoundationalEntry(path: string, key: string, value: Entry) {
  return edit(path, entries => entries.with(findEntry(entries, key), value));
}

export function removeFoundationalEntry(path: string, key: string) {
  return edit(path, entries => entries.toSpliced(findEntry(entries, key), 1));
}

export function mergeVocabulary(anki: AnkiEntry[], foundational: Entry[]) {
  const merged = new Map<string, VocabularyEntry>();
  for (const value of anki) {
    const key = entryKey(value);
    const existing = merged.get(key);
    if (existing) {
      existing.mature ||= value.mature;
      existing.exampleJa ??= value.exampleJa;
    } else merged.set(key, { ...value, sources: ["anki"] });
  }
  for (const value of foundational) {
    const existing = merged.get(entryKey(value));
    if (existing) existing.sources.push("foundational");
    else merged.set(entryKey(value), { ...value, sources: ["foundational"] });
  }
  return [...merged.values()];
}

const quotas = { Pronoun: 5, Noun: 35, Verb: 28, Adverb: 5, Adjective: 12 };

// Index only examples fully licensed by the same gate as generated Japanese.
export async function indexKnownExamples(entries: VocabularyEntry[], gate: VocabularyGate,
  analyze: (lines: string[]) => Promise<Token[][]>) {
  const examples = [...new Set(entries.flatMap(item => item.exampleJa ? [item.exampleJa] : []))];
  const index = new Map<string, string[]>();
  const analyses = await analyze(examples);
  for (const [i, example] of examples.entries()) {
    const { unknown, used } = coverage(example, analyses[i], gate);
    if (!unknown.length) index.set(example, used);
  }
  return index;
}

export function selectPracticeVocabulary(entries: VocabularyEntry[], seed: number, examples: Map<string, string[]>) {
  let state = seed;
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const sample = new Set<string>();
  const shuffledForms: string[] = [];
  for (const [pos, quota] of Object.entries(quotas)) {
    const forms = [...new Set(entries.filter(item => item.pos === pos && item.mature)
      .map(item => item.headword))].sort();
    const selected = shuffle(forms).slice(0, quota);
    for (const word of selected) sample.add(word);
    shuffledForms.push(...selected);
  }
  const knownVerbs = new Set(entries.filter(item => item.pos === "Verb").map(item => item.headword));
  const usable = (item: VocabularyEntry) => item.exampleJa && examples.get(item.exampleJa)?.includes(item.headword);
  const shown = new Set(entries.filter(item => sample.has(item.headword) || item.sources.includes("foundational")).map(item => item.headword));
  const scores = new Map<string, number>();
  for (const item of entries) {
    const example = item.exampleJa;
    if (!example || !usable(item)) continue;
    const words = examples.get(example)!;
    const compatible = knownVerbs.has(item.headword) || ((item.pos === "Noun" || item.pos === "Adjective")
      && words.some(word => knownVerbs.has(word)));
    if (!compatible) continue;
    // Past endings provide a stronger starting point for this benchmark. This is a ranking signal.
    const past = /(?:ました|ませんでした|った|いた|した|んだ|いだ)[。！？!?]*$/.test(example);
    const score = 1 + Number(past) * 2 + Number(words.every(word => shown.has(word)));
    scores.set(item.headword, Math.max(score, scores.get(item.headword) ?? 0));
  }
  const ranked = [...new Set(shuffledForms)].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  const targets = [
    ...ranked.filter(word => knownVerbs.has(word)).slice(0, 3),
    ...ranked.filter(word => !knownVerbs.has(word) && scores.has(word)).slice(0, 3),
  ];
  const selectedExamples = new Set<VocabularyEntry>();
  let supportBudget = 8;
  for (const target of targets) {
    const choices = entries.filter(item => item.headword === target && usable(item)).map(item => ({
      item, missing: examples.get(item.exampleJa!)!.filter(word => !shown.has(word)),
    })).sort((a, b) => a.missing.length - b.missing.length);
    const choice = choices[0];
    if (!choice || choice.missing.length > supportBudget) continue;
    selectedExamples.add(choice.item);
    for (const word of choice.missing) shown.add(word);
    supportBudget -= choice.missing.length;
  }
  const vocabulary = entries.filter(item => shown.has(item.headword)).map(item => {
    const { headword, reading, meaning, pos } = item;
    return { headword, reading, meaning, pos, ...(selectedExamples.has(item) ? { exampleJa: item.exampleJa } : {}) };
  });
  return { targets, vocabulary };
}
