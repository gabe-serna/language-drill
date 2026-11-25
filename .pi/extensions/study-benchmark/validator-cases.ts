import type { ReviewExercise } from "./generation.ts";

const pairs = [
  ["omitted-subject", true, "I read a book.", "本を読みました。"],
  ["natural-paraphrase", true, "I had dinner.", "夕飯を食べました。"],
  ["polite-negative", true, "I didn't go to school.", "学校へ行きませんでした。"],
  ["negation-reversed", false, "I didn't drink water.", "水を飲みました。"],
  ["different-action", false, "I listened to the voice.", "顔を見ました。"],
  ["invented-detail", false, "I read a book in the library.", "本を読みました。"],
  ["wrong-target", false, "I read a book.", "本を読んだ。"],
  ["japanese-grammar", false, "I read a book.", "本を読んだました。"],
  ["english-grammar", false, "Yesterday I reads a book.", "昨日本を読みました。"],
  ["sales-floor-is-not-store", false, "I went to the store.", "売り場へ行きました。"],
  ["lost-property-is-not-mistake", false, "I found a mistake.", "忘れ物を見つけました。"],
  ["lost-property-is-not-wallet", false, "I found a wallet.", "忘れ物を見つけました。"],
  ["added-town-name", false, "I forgot the town's name.", "町を忘れました。"],
  ["odd-object", false, "I decided the world.", "世界を決めました。"],
  ["contrived-situation", false, "I put a tobacco shop here.", "ここにたばこ屋を置きました。"],
  ["fire-collocation", false, "The fire went out.", "火事が消えました。"],
  ["sales-floor", true, "I went to the sales floor.", "売り場へ行きました。"],
  ["lost-property", true, "I found something I'd left behind.", "忘れ物を見つけました。"],
  ["fire-went-out", true, "The fire went out.", "火が消えました。"],
  ["past-motion", true, "The car moved.", "車が動きました。", "動きました"],
  ["future-plan-past-decision", true, "I decided to go tomorrow.", "明日行くと決めました。", "決めました"],
  ["tomorrow-completed-action", false, "I went to school tomorrow.", "明日学校へ行きました。", "行きました"],
  ["needless-redundancy", false, "I went back home.", "家へ家へ帰りました。", "帰りました"],
  ["plain-subordinate-clause", true, "I was hungry, so I ate bread.", "おなかが空いたのでパンを食べました。", "食べました"],
] as const;

export const validatorCases: { exercise: ReviewExercise; accepted: boolean }[] =
  pairs.map(([, accepted, english, referenceJa, verifiedPolitePastVerb], index) => ({
    accepted,
    // Opaque IDs prevent the label itself from giving the reviewer the answer.
    exercise: { id: String(index + 1), english, referenceJa, targetGrammarId: "polite-past", verifiedPolitePastVerb },
  }));

export const translationCases = [
  ["売り場へ行きました。", "Went to the sales floor, counter, or sales area. Store alone is too broad."],
  ["忘れ物を見つけました。", "Found an item left behind. The item is unspecified."],
  ["町を忘れました。", "Forgot the town. No name is mentioned, even if the Japanese is unusual."],
  ["ドアを開けませんでした。", "Did not open the door. Preserve negation and past tense."],
  ["火が消えました。", "The fire went out. Preserve the intransitive action."],
  ["ここに置きました。", "Put it here. The subject and object are omitted in Japanese."],
].map(([referenceJa, expected], index) => ({ sentence: { id: String(index + 1), referenceJa }, expected }));
