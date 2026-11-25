# Architecture

The implemented application is the project-local Pi study and benchmark extension under `.pi/extensions/study-benchmark/`. See the [roadmap](ROADMAP.md) for planned study features.

## Components

| Component | Responsibility |
| --- | --- |
| `index.ts` | Registers the study and benchmark commands, launches the local Python analyzer, calls Pi's model registry, and renders the report. The command requires an idle interactive Pi session at the project root. |
| `session.ts` | Parses study arguments, exposes the supported grammar, and tracks drafts, evaluated attempts, and outcomes, and drives progression using an injected view. |
| `grading.ts` | Builds isolated grading and reference explanation requests and validates structured model replies. |
| `anki.ts` | Reads eligible Core 2000 cards via AnkiConnect v6 at `127.0.0.1:8765`. The query selects review cards outside learning and suspension. A review interval of at least 21 days marks a card as mature for sampling. |
| `vocabulary.ts` | Merges known vocabulary by headword, reading, and meaning while preserving source provenance. Selects seeded practice samples and examples with known supporting vocabulary. Provides validated, atomic foundational vocabulary edits for explicit user actions. |
| `analyze.py` | Returns Sudachi Mode C tokens with surface, dictionary form, part of speech, out-of-vocabulary status, and character offsets. |
| `generation.ts` | Owns Japanese generation, deterministic coverage and duplicate checks, translation, review, refill selection, and metrics. |
| `validator-cases.ts` | Supplies fixed translation and quality-review cases for focused commands. |

The Core 2000 adapter maps `Vocabulary-Kanji`, `Vocabulary-Kana`, `Vocabulary-English`, `Vocabulary-Pos`, and `Expression` to headword, reading, meaning, part of speech, and example.

## Workflow

1. Import eligible Anki entries and foundational entries into an in-memory known vocabulary pool. Build an index of known expressions and choose a compact prompt sample using mature Anki entries and foundational vocabulary.
2. Generate Japanese sentences with a polite-past verb target. Morphology checks known surfaces and lemmas, exact aligned expressions, and narrowly permitted particles and auxiliaries. The pipeline checks the requested ending and exact Japanese duplicates, and tracks near-duplicates as a diversity signal.
3. Translate survivors in a separate call using Japanese sentences and IDs. Check the returned IDs and English duplicates.
4. Review the paired exercises in a fresh call for grammar, naturalness, meaning and target fit. Supply polite-past evidence where the analyzer corroborates the verb form. For an unconfirmed lemma, the reviewer checks suitability and supplies a dictionary-form kana reading and contextual English gloss.
5. Prefer known-only exercises. Hold eligible expanded exercises until the actual accepted count supports them under the percentage cap. Refills use rejection and diversity feedback, and can retire repeatedly implicated preferred targets. A full benchmark runs three seeded trials with ten exercise slots and up to two refills each.

Each inference stage uses the selected Pi model with a fresh context. The benchmark keeps generation and review data in memory and renders results in Pi's editor.

## Interactive study

Each invocation loads fresh vocabulary. The menu and direct drill share the same initialization path. A drill prepares at most ten exercises per generation batch, carries duplicate checks across batches, and offers the available questions if a batch finishes short. Percentage limits apply within each prepared batch. The command owns its question queue in memory, shares the benchmark busy guard, and cancels pending network or analyzer work when the user dismisses the preparation dialog. Pi editor and selection dialogs handle draft editing, feedback, give-up, and manual advance. Each grading call receives only the current English prompt, reference, and submitted answer. Failure or cancellation preserves the draft and leaves the three-attempt budget intact. Interim feedback is in English to keep the Japanese reference hidden. A correct grade, exhausted attempts, or give-up unlocks the reference and starts a separate, cancellable explanation call. The completion screen shows the submitted answer, accented reference and feedback. It starts one breakdown request per question and caches the result for the E toggle. Study debug traces stay in memory until exit. The summary reports correct questions and evaluated attempts.

## Configuration

- [Foundational vocabulary](../data/foundational-vocabulary.json) extends the known pool with explicit `headword`, `reading`, and `meaning` entries.
- [Vocabulary expansion](../data/vocabulary-expansion.json) sets `maxPercent` (integer 0–100, default 20) and `maxWordsPerExercise` (nonnegative integer, default 1). The cap applies to the actual final batch, including partial batches. Expansion is limited to dictionary-backed content words. Unknown grammatical tokens, proper nouns, numerals, out-of-vocabulary tokens, and uncovered spans fail coverage. Reviewer-provided readings and glosses are provisional.
