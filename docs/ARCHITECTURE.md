# Architecture

The study application has a portable TypeScript core in `src/core/`. The Windows Pi extension supplies the current interface and connects the core to local services. The [roadmap](ROADMAP.md) tracks milestone scope.

## Dependency boundaries

| Location | Responsibility |
| --- | --- |
| `src/core/prepare.ts`, `generation.ts` | Prepare drills from vocabulary entries, grammar catalog, expansion policy, analyzer and inference functions. Own tier allocation, batch limits, cross-batch duplicates, generation, translation, review, refills and final expansion limits. Report progress through an optional callback. |
| `src/core/session.ts`, `grading.ts` | Run the in-memory attempt and reveal loop through injected view callbacks. Construct grading and breakdown prompts and validate replies. |
| `src/core/grammar.ts`, `vocabulary.ts` | Validate grammar inventory and foundational entries, merge vocabulary with provenance, select practice samples, index examples, allocate difficulties and weight review recency. |
| `src/core/inference.ts`, `audio.ts` | Define inference, synthesis and playback contracts. Audio session logic owns preload, caching, replay ordering and cancellation. |
| `src/adapters/` | Read grammar configuration, access AnkiConnect, perform locked atomic foundational JSON edits, invoke Sudachi, synthesize WAV with VOICEVOX, and play it through Windows SoundPlayer. |
| `.pi/extensions/study-benchmark/` | Register commands, parse arguments, select adapters, load settings, render screens and benchmark reports, bind keys, manage cancellation and collect optional in-memory diagnostics. |

Dependencies point from the host to adapters and the core. Core modules import only other core modules and use standard JavaScript APIs. A standalone host can load the vocabulary and configuration, call `prepareQuestions`, then call `runQuestions` with its own editing, grading and reveal callbacks. The same `gradeAnswer` and `explainAnswer` functions serve each interface.

### Inference, analysis and audio

- An `Inference` function accepts a system prompt, a structured data payload and an output-token budget. It returns text and a stop reason. The core checks the envelope and validates the stage-specific JSON before accepting exercises or grades. Providers map completed responses to `stop` and token-budget truncation to `length`. Generation, translation, review, grading and explanation prompts live in the core.
- The Pi implementation in `.pi/extensions/study-benchmark/inference.ts` reads the selected model on every request, serializes the payload and creates a fresh message context. Pi owns provider settings and authentication. A future direct API or local-model adapter can implement the same function. For a web host, place credentialed calls in a server-side adapter and expose application operations to the browser. Keep keys and authentication headers out of client bundles, prompt data and study records.
- The analyzer accepts a batch of strings and returns one ordered token list per string. The Sudachi adapter resolves the local Python interpreter and script relative to its module, passes UTF-8 JSON over pipes, enforces cancellation and a timeout, and checks token tuple shapes.
- An `AudioProvider` accepts reference text and an abort signal and returns WAV bytes as a `Uint8Array`. Playback is a separate cancellable function. VOICEVOX handles speaker discovery, query and synthesis. The Windows player handles the OS process. A different host can replace either function independently.

### Storage and scheduling

The read-only Anki adapter maps `Vocabulary-Kanji`, `Vocabulary-Kana`, `Vocabulary-English`, `Vocabulary-Pos`, and `Expression` to headword, reading, meaning, part of speech, and example. The standard query selects eligible review cards outside learning and suspension. Recent study also includes learning cards. An interval of at least 21 days marks an entry mature for sampling.

Study state lasts for one invocation. Anki owns spaced-repetition scheduling. The core consumes maturity and review timestamps for selection. Grammar selection uses enabled inventory entries and tier eligibility. Persistent proficiency, adaptive difficulty and study history are future work. The application has no SQLite database or schema. A future SQLite or hosted adapter can supply the same entries and catalog to preparation. Foundational changes today require explicit authorization and use the file adapter.

## Workflow

1. Import eligible Anki entries and foundational entries into an in-memory known vocabulary pool. Build an index of known expressions and choose a compact prompt sample using mature Anki entries and foundational vocabulary.
2. Generate Japanese according to an enabled grammar and difficulty plan. The original benchmark uses polite past. Morphology checks known surfaces and lemmas, exact aligned expressions, and narrowly permitted particles and auxiliaries. The current deterministic filter requires the sole target ID to be polite-past and checks the ending. It rejects exact Japanese duplicates and tracks near-duplicates as a diversity signal.
3. Translate survivors in a separate call using Japanese sentences and IDs. Check the returned IDs and English duplicates.
4. Review the paired exercises in a fresh call for grammar, naturalness, meaning and target fit. Supply polite-past evidence where the analyzer corroborates the verb form. For an unconfirmed lemma, the reviewer checks suitability and supplies a dictionary-form kana reading and contextual English gloss.
5. Prefer known-only exercises. Hold eligible expanded exercises until the actual accepted count supports them under the percentage cap. Refills use rejection and diversity feedback, and can retire repeatedly implicated preferred targets. A full benchmark runs three seeded trials with ten exercise slots and up to two refills each.

Each inference stage uses the selected Pi model with a fresh context. The benchmark keeps generation and review data in memory and renders results in Pi's editor.

## Interactive study

Each invocation loads fresh vocabulary. The menu and direct drill share the same initialization path. A drill prepares at most ten exercises per generation batch, carries duplicate checks across batches, and offers the available questions if a batch finishes short. Refills preserve their difficulty tier. Mixed sessions shuffle accepted exercises, and spare session expansion capacity can fill open slots with previously reviewed candidates. The final percentage uses the actual session size. The command owns its question queue in memory, shares the benchmark busy guard, and cancels pending network or analyzer work when the user dismisses the preparation dialog. Pi editor and selection dialogs handle draft editing, feedback, give-up, and manual advance. Each grading call receives the current English prompt, reference, submitted answer, and number of retries available after this submission. Failure or cancellation preserves the draft and leaves the three-attempt budget intact. Corrective feedback can quote Japanese. The grader is instructed to withhold the full answer when an incorrect verdict leaves a retry. A correct or partially correct grade, exhausted attempts, or give-up unlocks the reference and starts a separate, cancellable explanation call. The completion screen shows the submitted answer, accented reference and feedback. It starts one breakdown request per question and caches the result for the E toggle. Study debug traces stay in memory until exit. The summary reports correct and partially correct questions and evaluated attempts.

## Difficulty and recency

Entries marked `supportingOnly` can support a target without satisfying the target requirement themselves. The independent reviewer checks structural difficulty and allowed grammar in the same request as linguistic quality. Its accepted grammar IDs and assessed tier must match the plan. Difficulty remains a model judgment. Higher tiers can combine enabled lower-tier constructions when their proposed grammar is disabled. The vocabulary gate remains separate.

With recent sampling, AnkiConnect reads review history in chunks and uses the latest rated review timestamp per card. Weighted sampling without replacement applies a linear boost that decays to the baseline weight by the end of the configured window. Card interval plays no role in the boost.

## Configuration

- [Grammar inventory and selection settings](../data/grammar.json) define proposed and enabled patterns, the 50/30/20 default mix, and a 30-day recency window with a maximum additional weight of 4.

- [Foundational vocabulary](../data/foundational-vocabulary.json) extends the known pool with explicit `headword`, `reading`, and `meaning` entries.
- [Vocabulary expansion](../data/vocabulary-expansion.json) sets `maxPercent` (integer 0–100, default 20) and `maxWordsPerExercise` (nonnegative integer, default 1). The cap applies to the actual final batch, including partial batches. Expansion is limited to dictionary-backed content words. Unknown grammatical tokens, proper nouns, numerals, out-of-vocabulary tokens, and uncovered spans fail coverage. Reviewer-provided readings and glosses are provisional.

Reference audio preloads asynchronously when each question begins. Only the revealed feedback screen initiates playback. Leaving it cancels pending playback, and closing the session aborts outstanding synthesis and releases cached audio. WAV bytes travel over stdin without temporary files.
