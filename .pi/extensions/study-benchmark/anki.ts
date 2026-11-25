import type { AnkiEntry } from "./vocabulary.ts";

const query = 'deck:"Core 2000" is:review -is:learn -is:suspended';
type Card = { cardId: number; interval: number; fields: Record<string, {value: string}> };

async function anki<T>(action: string, params: object): Promise<T> {
  const response = await fetch("http://127.0.0.1:8765", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }), signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("AnkiConnect is unreachable. Open Anki and check the add-on."); });
  if (!response.ok) throw new Error("AnkiConnect HTTP " + response.status);
  const data = await response.json() as { result: T; error: string | null };
  if (data.error !== null) throw new Error("AnkiConnect: " + data.error);
  return data.result;
}

export async function loadAnkiVocabulary() {
  const ids = await anki<number[]>("findCards", { query });
  if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isSafeInteger)) {
    throw new Error("Core 2000 returned no eligible cards or returned invalid card IDs.");
  }
  const entries: AnkiEntry[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const cards = await anki<Card[]>("cardsInfo", { cards: chunk });
    if (!Array.isArray(cards) || new Set(cards.map(card => card.cardId)).size !== chunk.length
        || !cards.every(card => chunk.includes(card.cardId))) {
      throw new Error("AnkiConnect returned an incomplete card batch.");
    }
    for (const card of cards) {
      const word = card.fields?.["Vocabulary-Kanji"]?.value?.normalize("NFC").trim();
      const pos = card.fields?.["Vocabulary-Pos"]?.value;
      if (!word || /[<>\n\r]|\[sound:/.test(word) || typeof pos !== "string" || !Number.isFinite(card.interval)) {
        throw new Error("A Core 2000 card has a field outside the verified benchmark format.");
      }
      const reading = cleanField(card.fields["Vocabulary-Kana"]?.value);
      const meaning = cleanField(card.fields["Vocabulary-English"]?.value);
      const example = cleanField(card.fields.Expression?.value);
      entries.push({ headword: word, reading, meaning, pos, mature: card.interval >= 21,
        exampleJa: example && example.length <= 100 ? example : undefined });
    }
  }
  return { entries, count: ids.length };
}

// The verified Core 2000 Expression field contains short example sentences with inline emphasis.
function cleanField(raw = "") {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return raw.replace(/<(script|style|rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\[sound:[^\]]+\]/gi, "").replace(/<\/?(?:br|div|p)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
      const key = entity.toLowerCase();
      if (key[0] !== "#") return entities[key];
      const code = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
    }).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").normalize("NFC").trim();
}

