import type { Recent } from "./grammar.ts";
import { coverage, type VocabularyGate, type Token } from "./generation.ts";
export type Entry = { headword: string; reading: string; meaning: string };
export type AnkiEntry = Entry & { pos: string; mature: boolean; reviewedAt?: number; exampleJa?: string };
export type VocabularyEntry = Entry & {
  sources: ("anki" | "foundational")[];
  pos?: string;
  mature?: boolean;
  reviewedAt?: number;
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

export function parseEntries(value: unknown, path: string): Entry[] {
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

export function mergeVocabulary(anki: AnkiEntry[], foundational: Entry[]) {
  const merged = new Map<string, VocabularyEntry>();
  for (const value of anki) {
    const key = entryKey(value);
    const existing = merged.get(key);
    if (existing) {
      existing.mature ||= value.mature;
      existing.reviewedAt = Math.max(existing.reviewedAt ?? 0, value.reviewedAt ?? 0) || undefined;
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

export function recencyWeight(reviewedAt: number | undefined, recent: Recent, now: number) {
  if (reviewedAt === undefined) return 1;
  const age = Math.max(0, now - reviewedAt) / 86_400_000;
  return 1 + recent.boost * Math.max(0, 1 - age / recent.windowDays);
}

export function selectPracticeVocabulary(entries: VocabularyEntry[], seed: number, examples: Map<string, string[]>, recent?: Recent, now = Date.now()) {
  let state = seed;
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const recency = new Map<string, number>();
  if (recent) for (const item of entries) {
    recency.set(item.headword, Math.max(recency.get(item.headword) ?? 1, recencyWeight(item.reviewedAt, recent, now)));
  }
  const sample = new Set<string>();
  const shuffledForms: string[] = [];
  for (const [pos, quota] of Object.entries(quotas)) {
    const forms = [...new Set(entries.filter(item => item.pos === pos && (recent ? item.sources.includes("anki") : item.mature))
      .map(item => item.headword))].sort();
    const ranked = recent ? forms.map(word => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return { word, score: -Math.log((state + 1) / 4294967297) / (recency.get(word) ?? 1) };
    }).sort((a, b) => a.score - b.score).map(item => item.word) : shuffle(forms);
    const selected = ranked.slice(0, quota);
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
    const score = 1 + Number(words.every(word => shown.has(word)));
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
