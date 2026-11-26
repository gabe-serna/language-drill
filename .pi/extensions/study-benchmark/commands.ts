import { levels, type Difficulty } from "../../../src/core/grammar.ts";

export function studyCommand(args: string): { count: number; difficulty?: Difficulty; recent: boolean } | undefined {
  if (!args.trim()) return undefined;
  const [command, ...tokens] = args.trim().split(/\s+/);
  const options: { count: number; difficulty?: Difficulty; recent: boolean } = { count: 10, recent: false };
  const invalid = () => new Error("Usage: /study drilling [--q <positive integer>] [--difficulty easy|medium|hard] [--recent]");
  if (command !== "drilling") throw invalid();
  const seen = new Set<string>();
  while (tokens.length) {
    const flag = tokens.shift()!;
    if (seen.has(flag)) throw invalid();
    seen.add(flag);
    if (flag === "--recent") options.recent = true;
    else if (flag === "--difficulty") {
      const value = tokens.shift();
      const difficulty = levels.find(level => level === value);
      if (!difficulty) throw invalid();
      options.difficulty = difficulty;
    } else if (flag === "--q") {
      const value = tokens.shift() ?? "";
      const count = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) throw invalid();
      options.count = count;
    } else throw invalid();
  }
  return options;
}

export function studyCompletions(prefix: string) {
  const split = prefix.lastIndexOf(" ") + 1;
  const base = prefix.slice(0, split);
  const fragment = prefix.slice(split);
  const prior = base.trim().split(/\s+/);
  const last = prior.at(-1);
  const options = !base ? ["drilling"] : prior[0] !== "drilling" ? []
    : last === "--difficulty" ? levels : last === "--q" ? ["10"]
    : ["--q", "--difficulty", "--recent", "--debug"].filter(option => !prior.includes(option));
  const matches = options.filter(option => option.startsWith(fragment)).map(option => ({ value: base + option, label: option }));
  return matches.length ? matches : null;
}
