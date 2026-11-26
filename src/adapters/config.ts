import { readFileSync } from "node:fs";
import { parseGrammar } from "../core/grammar.ts";

export function loadGrammar(path: string) {
  return parseGrammar(readFileSync(path, "utf8"));
}
