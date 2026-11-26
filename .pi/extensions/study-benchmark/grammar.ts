import { readFileSync } from "node:fs";

export const levels = ["easy", "medium", "hard"] as const;
export type Difficulty = typeof levels[number];
export type GrammarEntry = {
  id: string; name: string; pattern: string; description: string;
  usageRules: string[]; difficulty: Difficulty; enabled: boolean; supportingOnly?: boolean; examples: string[];
};
export type Recent = { windowDays: number; boost: number };
type Distribution = Record<Difficulty, number>;

export const guidance: Record<Difficulty, string> = {
  easy: "One straightforward action or state with simple modifiers. A basic past action at a place and time can still be easy.",
  medium: "A simple relationship between clauses, such as sequence or a reported instruction if enabled, or a single clause with several roles to encode. A time, location and quantity in an existence sentence or a time, location and companion with one ordinary action can be medium.",
  hard: "Combine multiple grammatical or structural concepts. Use contrasting events if enabled, or encode multiple interacting relationships within one clause, such as a precise time, route from a source to a destination, companion and action. Naturalness and clarity take priority over length.",
};

export function loadGrammar(path: string) {
  const data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  const list = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(text);
  const entries: GrammarEntry[] = data?.entries;
  if (!Array.isArray(entries) || entries.some(entry => !entry ||
    ![entry.id, entry.name, entry.pattern, entry.description].every(text) ||
    !list(entry.usageRules) || !list(entry.examples) || !levels.includes(entry.difficulty) || typeof entry.enabled !== "boolean" || (entry.supportingOnly !== undefined && typeof entry.supportingOnly !== "boolean")
  ) || new Set(entries.map(entry => entry.id)).size !== entries.length || !entries.some(entry => entry.enabled && !entry.supportingOnly))
    throw new Error("Invalid grammar.json entries. Provide unique IDs and at least one enabled target.");
  const distribution: Distribution = data.distribution;
  if (!distribution || levels.some(level => !Number.isInteger(distribution[level]) || distribution[level] < 0) ||
    levels.reduce((sum, level) => sum + distribution[level], 0) !== 100)
    throw new Error("Grammar difficulty percentages must be nonnegative integers totaling 100.");
  const recent: Recent = data.recent;
  if (!recent || !Number.isSafeInteger(recent.windowDays) || recent.windowDays < 1 || !Number.isFinite(recent.boost) || recent.boost < 0)
    throw new Error("Invalid recency settings.");
  return { entries: entries.filter(entry => entry.enabled), distribution, recent };
}

export function allocate(count: number, distribution: Distribution, difficulty?: Difficulty) {
  if (difficulty) return [{ difficulty, count }];
  const total = BigInt(count);
  const shares = levels.map(difficulty => {
    const exact = total * BigInt(distribution[difficulty]);
    return { difficulty, count: Number(exact / 100n), remainder: Number(exact % 100n) };
  });
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder);
  const extra = count - shares.reduce((sum, share) => sum + share.count, 0);
  for (let i = 0; i < extra; i++) ranked[i].count++;
  return shares.filter(share => share.count).map(({difficulty, count}) => ({ difficulty, count }));
}

export function shuffle<T>(items: T[], random = Math.random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
