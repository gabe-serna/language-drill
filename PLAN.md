# Japanese sentence-production trainer

## Scope

Build a typed quiz that starts with `/study` in Pi. The learner sees one English prompt at a time and produces a Japanese translation. Each reference uses the session's Anki vocabulary plus explicitly permitted grammatical forms. The active Pi model grades alternatives, gives brief feedback, and supports hints and another attempt. The MVP is one ten-exercise session with a summary. The MVP uses manually typed Japanese throughout. Future input methods can supply the same text draft through the UI boundary. Windows voice typing is independent of the application. A standalone desktop UI follows separately.

Initial workspace inspection found an empty `D:\Scripting\japanese-study` directory with no Git repository, project configuration, or existing instructions. Installed versions, Anki field mappings, and model behavior remain live verification items. This document proposes defaults for the first trial.

## Architecture decisions

| Concern | Options considered | Decision |
| --- | --- | --- |
| Quiz control | Skill-led conversation, full-screen TUI, extension command with built-in dialogs | Use the extension command with Pi dialogs for typed input and actions. The skill documents how to start the trainer and what to expect. |
| Inference | Pi conversation turns or direct Pi registry calls | Resolve the active Pi model for each request and use its registry with an isolated context. Local and cloud models use the same boundary. Report unsupported isolated inference explicitly. |
| Vocabulary gate | Substring or regex lookup, JS tokenizer, SudachiPy | Use SudachiPy with the core dictionary. It supplies lemma, normalization, POS, reading, and multiple segmentation granularities. Kuromoji.js offers a simpler JS deployment and is the comparison candidate if Sudachi setup or accuracy fails the spike. Compare on the same labeled cases. [SudachiPy](https://pypi.org/project/SudachiPy/) · [Kuromoji.js](https://github.com/takuyaa/kuromoji.js) |
| Analyzer integration | Native Node binding, local HTTP daemon, subprocess | Start with a UTF-8 JSON request/response subprocess per bulk analysis operation. Batch input and measure dictionary startup cost. Adopt a session-scoped JSON Lines worker if that cost materially affects the quiz. |
| State and reuse | Pi session entries, persistent store, in-memory controller | Keep all study state in a TypeScript controller. A future desktop host supplies the UI and model transport and reuses the controller, validation and prompts. |

## Components and contracts

These are proposed boundaries and data shapes. Use plain types and functions until an implementation requires more structure.

| Component | Contract and responsibility |
| --- | --- |
| Anki adapter | `loadVocabulary(source, signal) → VocabSnapshot`. Reads configured cards and fields, deduplicates source notes, extracts lexical entries, and returns import counts and warnings. The snapshot carries lexical IDs, canonical forms, approved aliases, optional readings and glosses, and local provenance. |
| Grammar loader | `loadGrammar(config) → GrammarCatalog`. Checks schema version, unique IDs, prerequisites, cycles and supported rules. Computes eligible IDs from configured known grammar and difficulty. |
| Morphology adapter | `analyzeMany(texts, signal) → Analysis[]`. Returns keyed results in input order with original spans, surface, dictionary and normalized forms, readings, POS/subtypes, OOV status and C/B/A split information. Use Unicode code-point offsets across the process boundary and convert explicitly when slicing in JavaScript. Python analyzes text. TypeScript owns the allow policy. |
| Reference validator | `validateReference(analysis, snapshot, policy) → CoverageResult`. Returns covered lexical IDs and reasoned unmatched spans. Accepts only complete coverage with at least one known lexical item. |
| Model transport | `complete(request, signal) → ModelReply`. Takes a bounded system instruction, one data message and call settings. Returns assistant text, finish category and available usage. All wire parsing stays outside the quiz state machine. |
| Japanese author, translator, reviewer and grader | The author writes Japanese only. The deterministic gate checks vocabulary, target grammar and duplication. The translator produces English from the surviving Japanese. The reviewer independently accepts or rejects the resulting pairs. The grader handles learner answers separately. |
| Study controller | `start`, `submit`, `hint`, `retry`, `next`, `skip`, `finish` and `cancel`. Owns the immutable vocabulary and grammar snapshots, accepted queue, cursor, per-item attempt and hint counts, duplicate detection and summary. Exposes a view of the current prompt and legal actions. Keeps unrevealed references internal. |
| Answer input | Host input supplies an editable text draft for the current exercise. Only explicit submission sends it to grading. The Pi MVP uses the typed dialog and the controller receives text through the same boundary on desktop. |
| Pi adapter and skill | The extension binds project services to the controller and renders its views through dialogs and status. The skill explains `/study`, the typed workflow and setup expectations. It carries neither runtime state nor the authoritative prompts. |

Data flows from AnkiConnect and the grammar file into session snapshots. A small vocabulary sample and eligible grammar go to the active Pi model. Generated references pass through Sudachi and the full local whitelist before reaching the queue. Learner text goes to the grader for the current exercise only. Valid feedback comes back to the same quiz item. The controller computes the summary from its state.

## Anki ingestion

- Use one read-only bootstrap per study session. Start with API v6 at the configured loopback URL, commonly `http://127.0.0.1:8765`. Check `version`, call `findCards`, and retrieve `cardsInfo` in bounded chunks. Check HTTP, Anki's `result` and `error` envelope, cardinality, and response shapes. `cardsInfo` supplies note identity, model, fields and interval in the upstream archive. Verify the installed payload before committing to it. If required, fetch `notesInfo` for unique note IDs during bootstrap. Anki can be closed after a successful snapshot. [AnkiConnect upstream and move notice](https://github.com/FooSoft/anki-connect) · [Upstream API implementation](https://github.com/FooSoft/anki-connect/blob/master/plugin/__init__.py) · [API examples in the community fork](https://github.com/ankicommunity/anki-desktop-addon-connect#api)
- Configure deck and any note-type, card-template or tag filters. Proposed default is `deck:"<configured deck>" is:review -is:learn -is:suspended`, with regular review cards eligible and intervals of at least 21 days preferred when sampling. Allow a mature-only query with `prop:ivl>=21`. Verify in Anki's Browser that the query selects the intended subdecks and recognition or production cards. First-time learning, lapsed and suspended cards are excluded by the default. A note qualifies if at least one in-scope card qualifies. Count cards and unique lexical entries separately. The supplied estimates of 1,000 studied and 800 mature items are planning inputs. [Anki search syntax](https://docs.ankiweb.net/manual/searching) · [Anki maturity definition](https://docs.ankiweb.net/manual/stats)
- Map each supported note type to its headword field and optional reading, gloss and explicit variant fields. Parse HTML as an inert fragment, preserve intentional separators, decode entities, remove ruby readings from the base expression, and strip media markers and non-content elements. Apply Unicode NFC and trim. Avoid free splitting on punctuation or adding words from example sentences, glosses or furigana. Handle inflected, cloze, sentence-only and ambiguous multi-entry fields through an explicit per-model rule or leave them out with a count. Confirm examples of each format locally. Deduplicate equivalent records while retaining distinct readings and senses as metadata. An exact written form can still carry several senses.
- Report counts by eligibility, unmapped type, missing field, skipped value and deduplication. Stop setup on an empty usable whitelist, a missing required mapping for a configured type, or a failed fetch. Keep an optional key in local configuration or the environment, never in fixtures. Use a synthetic example config with representative field names once the real mapping is understood.

## Vocabulary and grammar validation

**Coverage rule.** Every non-formatting span in a generated Japanese reference must be covered by a known Anki entry or a curated grammatical element enabled for the exercise. Deny unknown and ambiguous spans by default. This is strict under the implemented analysis policy. A tokenizer can mis-segment a word or select the wrong reading or sense, so measure those errors against human-labeled examples.

1. Use the same canonicalization for deck values and references, preserving the displayed original. Start with NFC and targeted, tested width and orthographic normalization. Build exact-form and approved variant indexes. Analyze individual entries to obtain POS and lemma/reading metadata, while retaining explicitly mapped whole compounds and phrases. Guard against expanding a whole phrase into separately known words during import.
2. Start with Sudachi Mode C and match known whole-token surfaces, resolved lemmas, and approved normalized variants. Use POS and reading evidence where available to reject conflicting analyses. The match for `食べました` should cover `食べる` plus permitted auxiliary morphology. Unknown kanji homophones stay unknown even when the reading matches. Kana spellings can match explicit aliases or a fixture-backed unambiguous analyzer mapping. Avoid global reading equivalence, indiscriminate NFKC and substring matches inside larger words.
3. Handle compounds conservatively. Prefer a known whole lexeme. Permit an explicitly imported multi-token expression only across exact analyzer boundaries as a complete, contiguous span, with reviewed context for ambiguous expressions. For a C token with a B/A decomposition, initially allow fallback only for reviewed compositional cases or specific analyzer boundary exceptions. Knowing `手` and `紙` alone must never make `手紙` known. Digit sequences, counters, lexical suffixes, proper names, alphabetic words and OOV spans require explicit entries or reviewed rules. A genuinely known OOV spelling can pass via an exact, boundary-aligned approved entry. Use a narrow set of punctuation and whitespace. Reject gaps, unexpected characters and references containing only grammatical material.
4. Approve function words by form and POS or a tested span pattern. Avoid exemptions for entire POS classes. Keep particles, inflectional auxiliaries, copula forms and grammatical multi-token patterns in versioned data. An apparent particle use of `の` can qualify through a rule. A homographic lexical item needs a lexical match. Treat lexicalized `する` compounds and lexical versus auxiliary `いる` as fixtures. For example, knowing an isolated noun does not automatically authorize a lexical compound formed from it.
5. Keep `data/grammar.json` separate from the deck. Give each concept an ID, label, difficulty, prerequisite IDs, a concise prompt description, and optional curated function spans or positive/negative surface checks. Set known IDs in configuration. A target is eligible only when its ID is enabled, its prerequisite closure is marked known, and it meets the selected difficulty. Start with a handful of patterns that can be checked with analyzed spans, such as polite past verb forms. Support permitted baseline grammar plus one target per item. Check the exercise's claimed target against the request and the actual reference. Reject detectable out-of-scope patterns. Grammar IDs and token patterns cannot certify all Japanese constructions. Have the selected model check semantic alignment, target use and permitted grammar while authoring, with a human audit in the spike and a targeted verification call only if evaluation shows it is needed. Keep unsupported target patterns out of the initial pool.

Pin a tested SudachiPy and `sudachidict_core` pair. PyPI lists Windows x64 wheels for 0.6.11. The 0.7 documentation flags a dictionary format change and instability, so begin compatibility testing with the 0.6.11 line and a matching dictionary. Check behavior in sentences and in isolated headwords. Record actual analyzer outputs before approving exceptions. [SudachiPy 0.6.11 release files](https://pypi.org/project/SudachiPy/0.6.11/#files) · [SudachiPy migration notes and examples](https://pypi.org/project/SudachiPy/) · [Sudachi segmentation and normalization](https://github.com/WorksApplications/Sudachi/blob/develop/README.md)

## Pi model selection and project discovery

- Read the live model from `ctx.model` immediately before every generation, refill and grading call. Use `ctx.modelRegistry.streamSimple(model, context, options).result()` for provider-neutral options such as an abort signal and token cap. Give each request a fresh system instruction and one task payload, with no tools or chat history. Collect assistant text and handle error, abort and truncation explicitly. If the installed registry or active model cannot perform isolated chat completion, report the limitation. Pi owns model selection and authentication. Use Pi's normal model picker to switch between calls or study runs without changing project configuration. An in-flight call keeps the model it started with. Keep prompts, replies and state out of Pi session entries. Selected cloud models receive the task payload, including the sampled headwords during generation or the submitted answer during grading. [Pi extension context and registry calls](https://docs.pi.dev/latest/extensions#streaming-model-calls)
- Place the extension and skill only in the workspace's `.pi/extensions/japanese-study/` and `.pi/skills/japanese-study/` directories. Use Pi's trusted working-directory discovery. Leave global paths, package registration and user settings alone. Resolve the project root from the extension location and check the canonical working directory before accepting a study command. Verify discovery from the trusted root and absence in an unrelated working directory. [Pi extension discovery](https://docs.pi.dev/latest/extensions#extension-locations) · [Pi skills](https://docs.pi.dev/latest/skills) · [Project configuration](https://docs.pi.dev/latest/configuration)
- Register `/study` with `pi.registerCommand` and require an idle interactive Pi terminal. Use `ctx.ui.input` for typed answers, `ctx.ui.select` for actions, and a widget or status for progress. Escape opens hint, skip and finish actions. Add a minimal cancellable progress view only if needed. Use a custom quiz component only if dialogs fail the Windows IME or interaction test. [Pi extensions and UI](https://docs.pi.dev/latest/extensions) · [Pi on Windows](https://docs.pi.dev/latest/windows)

## Generation, grading and hints

At startup, read the student-approved [foundational vocabulary](data/foundational-vocabulary.json) and merge it in memory with Anki records. A distinct record is a normalized written form, reading and English definition. Merged records retain both source labels when applicable. Read the file again for each benchmark run or future study session. Its initial contents are an explicit small list. Manual edits or programmatic operations initiated by the user are the only way to add entries. `vocabulary.ts` exposes read, add, update and remove functions independent of Pi. Edits validate before writing, lock against another application edit, compare on-disk contents for manual conflicts and atomically replace the original using a sibling UTF-8 temporary file. Startup reads leave the file untouched.

The benchmark retains three seeded trials with ten requested exercises per trial and two refills. Sample up to 85 mature Anki written forms across the existing parts-of-speech quotas and include foundational entries. For the polite-past verb target, prefer up to three sampled verbs, favoring those with fully covered examples, and up to three sampled nouns or adjectives whose covered example also uses a known verb. Include up to eight additional known supporting headwords across the selected examples. Preferred targets are optional. Send readings and English definitions from the source records and at most six short Anki Japanese examples for target words. Examples are language references. Their text never expands the whitelist.

The Japanese author thinks of a plausible everyday situation and returns one object containing a sentences array of Japanese strings. The application assigns the requested grammar and an identifier derived from attempt number and original array position, stable within the trial through translation and review. It varies verbs and constructions where useful. The prompt asks the author to leave imagined contexts and English out of its response. Apply the schema, target, full merged vocabulary and Japanese duplicate checks before translation.

Use prompted JSON with strict local runtime validation as the baseline. Verify any provider-side schema enforcement before using it. Limit response size, string lengths and item count, and check IDs, language plausibility and duplicate prompts/references. Parse exactly one response object. Keep valid siblings from a structurally readable batch when individual candidates fail. A malformed envelope or truncated JSON counts as a failed call. The gate checks the full snapshot even when the model chooses a known word outside the supplied sample.

Translate the survivors in one fresh model call containing only Japanese sentences and their stable identifiers. The translator must preserve meaning, tense, aspect, negation, agency and modality, handle omitted subjects, and add no unsupported details. Match all translations to the original IDs and check duplicate English prompts. An invalid translation response admits none of its batch.

Review the translated pairs in a third isolated batch with its own prompt. The reviewer checks fidelity, grammar and naturalness in both languages, the target construction, and whether the Japanese works as a standalone everyday exercise. It accepts ordinary ambiguity and reasonable phrasing variation. It rejects misleading or contrived examples and returns decisions and concise reasons without rewriting. Missing, duplicate, unknown or malformed decisions admit zero candidates from that review. Each stage resolves the active Pi model with a fresh context. Skip any downstream call with an empty input.

Allow two automatic refill requests per preparation attempt and request only missing items. Give the author earlier accepted and rejected Japanese sentences with rejection reasons, then rerun the full chain. Suppress previously seen Japanese even when the earlier attempt failed at translation or review. Keep accepted exercises and offer an explicit retry or a clearly labeled shorter quiz if the budget expires. If zero pass, end preparation with a diagnostic and a retry option.

For grading, send the English prompt, validated reference, target or stated register, and current learner answer. Treat the answer as quoted data and instruct the model to judge meaning first, then grammar and naturalness. Accept synonymous expressions, topic or subject omission, equivalent structures, and register variations consistent with the prompt. Grade a missed target separately when explicitly required. Do not penalize the learner for using vocabulary outside Anki. Ask for bounded JSON with `outcome` (`accepted`, `needs_revision`, `uncertain`), short findings for meaning, grammar and naturalness, and an optional `correctionJa`. A plausible interpretation caused by an ambiguous English prompt should be accepted or marked uncertain with a brief explanation. Use the same gate for model-written Japanese teaching examples and show a verified reference if a correction fails coverage. Show the full correction after reveal or when appropriate after a successful answer. Keep it hidden while the learner is retrying unless they choose reveal. Hints use the grammar cue or a verified lexical cue, avoid giving the answer, and require no additional model call. Grade failures preserve the draft and permit retry or skip without recording a wrong answer.

Start with sequential calls. Record elapsed time, available token usage, validation yield, rejection reasons and retry counts with content-free diagnostics. At 40–60 tokens/sec on the existing local setup, a 600–1,200 token batch implies roughly 10–30 seconds of decoding before prefill, reasoning and retries. Measure cold versus warm startup and grading separately. Keep configuration and lexical indexes in memory. Consider prefetch of a later batch only if sessions grow beyond ten items and timing data supports it. Prompt caching can be tested independently of correctness.

## Session lifecycle and recovery

1. `/study` enters setup. Acquire one active-session guard, resolve configuration and check that Pi has selected a model, load Anki and grammar once, and prepare the lexical index and initial batch. Show the stage and expose cancellation. A duplicate invocation reports that a session is active.
2. Enter the prompt state with an accepted exercise. Input is an ephemeral draft until submitted. Reject empty input locally. During grading, bind results to the session and exercise/attempt ID. Permit one in-flight transition at a time and ignore late replies after cancellation or item changes.
3. Enter feedback on a valid grade. Offer next, retry, hint, reveal/skip or finish as applicable. Retry keeps the same prompt and appends an evaluated attempt only after successful grading. Next finalizes the item once. Skip without an accepted answer is recorded separately. A revealed item cannot subsequently count as first-pass success.
4. Finish after the last item or on explicit early finish. Report prepared and reached counts and one final outcome per item. Use accepted before reveal, skipped/revealed, reached without resolution, and untouched. Report first-pass accepts as a subset of accepts and count hints separately. Mark uncertain results clearly. Release the session and restore Pi UI on finish, cancel or failure.
5. Keep the live controller independent of transcript compaction. On Pi `session_shutdown` including quit, reload and session replacement, abort requests, stop any analyzer child, clear UI resources and discard volatile state. Opening a new study session builds a fresh snapshot. [Pi lifecycle events](https://docs.pi.dev/latest/extensions#session_shutdown)

Use bounded deadlines for Anki, analyzer and model calls. Distinguish startup failures, provider connection/auth errors, schema or coverage rejection, analyzer process failures, and user cancellation. Offer a specific recovery action for each. An analyzer failure blocks new references until analysis succeeds again. Clean up on timeout by terminating the spawned executable and discarding its partial reply. Verify usable UTF-8 and no orphan child process on the target OS.

## Proposed layout

| Path | Purpose |
| --- | --- |
| `.pi/extensions/japanese-study/index.ts` | Pi command registration, registry model adapter and host lifecycle glue |
| `.pi/extensions/japanese-study/ui.ts` | Pi dialog and progress rendering |
| `.pi/skills/japanese-study/SKILL.md` | Discoverable learner workflow and setup notes |
| `src/study/` | Session controller, grammar policy, reference acceptance and model contracts |
| `src/study/prompts/` | Generation and grading instructions and response schemas |
| `src/adapters/` | AnkiConnect and Sudachi process adapters reusable on desktop |
| `tools/sudachi_analyze.py` | Local batch morphology bridge |
| `data/grammar.json` | Grammar concepts, prerequisites and allowed forms |
| `config/study.example.json` | Example settings for Anki selector and fields, and grammar |
| `tests/fixtures/` | Synthetic Anki payloads, analyzer cases and representative model replies |

For desktop, reuse the study controller, Anki/Sudachi adapters, grammar catalog and model prompts in a Node-capable backend or main process. The desktop view supplies answer drafts and controller actions and receives UI-safe state. A desktop model adapter implements the same provider-agnostic transport contract. Revisit how to bundle the analyzer and dictionary when packaging becomes necessary.

## Milestones and acceptance tests

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| 1. Windows integration proof of concept | Confirm installed Pi APIs, read-only Anki import shape, one Sudachi batch, and authoring and grading through the active Pi model. Use a minimal disposable probe or smoke harness after approval. | Match the Anki Browser query against imported card counts and inspect a representative set of supported fields and deduplication. Verify a typed IME answer and an aborted registry call, switch models through Pi without configuration edits and confirm subsequent calls use the new selection. Verify isolated calls leave chat history unchanged and verify root-only project discovery for the extension and skill. Run a labeled corpus of at least 30 positive and 30 negative coverage cases and require zero known false accepts in that corpus. Record false rejects and why. Run three independent ten-item generation trials, report first-pass/final yield and wall time, and require at least two trials to reach ten accepted items within the proposed refill budget before continuing with the chosen sample/prompt strategy. Manually audit accepted English/reference pairs for meaning, naturalness and target fit. |
| 2. Deterministic core and data | Define grammar JSON, vocabulary mapping, coverage policy and session transitions, using fakes for remote boundaries. | Test malformed fields/HTML, mixed note types, cloze/ruby, card and lemma dedupe, prereq cycles, and unknown tags. Test allowed conjugation, unknown homophone, lexicalized compound, particle/lexical ambiguity, OOV, punctuation and exact multi-token coverage. Test follow-up failure, duplicate submit, late reply after cancellation, and summary counts. |
| 3. Typed Pi MVP | Wire `/study`, local batch generation, grading, hints, retries and summary. Add the project-local companion skill. | Walk through all ten items without a second Anki load. Confirm reference stays hidden during retries, alternatives pass, and disallowed references never enter the queue. Simulate malformed JSON, truncation, unavailable Anki, model timeout and analyzer exit. Verify no false scoring on service failure, clean finish/cancel and repeatable `/study`. Exercise Windows IME composition, Enter/Escape, paste and terminal width. Verify no new Pi conversation entries from normal study and no coupling to compaction. |
| 4. Evaluate and tune | Evaluate the active Pi model with a small human-labeled translation set and review a real session. | Include omitted subjects, synonyms, wrong tense/negation/particles, unnatural but correct phrasing, missed requested patterns and ambiguous prompts. Report disagreement with expected feedback, false rejections and actual startup/grade latencies. Tune prompts, sample size or safe analyzer exceptions based on those results. |
| Later. Desktop | Reuse the controller behind a desktop view. | The desktop adapter can run the same controller tests. |

## Milestone 1 results · November 24, 2026

Overall status is **incomplete**. Anki, Sudachi, the labeled vocabulary corpus, isolated Pi transport and Windows IME passed their checks. The earlier bilingual Gemma 4 12B benchmark reached the automated yield threshold, with residual errors. The current Japanese-first pipeline passed its focused translation audit but missed the live batch-yield threshold.

| Check | Result | Evidence |
| --- | --- | --- |
| Installed Pi API and project discovery | Pass | Pi 1.5.2 on Windows exposed the registry API. Its RPC command list contained the temporary extension command and skill when launched from the trusted workspace. Both were absent when launched from an unrelated directory with the same isolated Pi profile. The normal global profile was outside the writable sandbox, so probes used a temporary agent directory. |
| Active model switching and isolated requests | Pass with synthetic models | Switched via Pi RPC `set_model` between two fixture models without changing project configuration. Each extension request used the newly selected ID. The fixture server received exactly a system instruction and one task message. Study calls left session entry counts unchanged. A pre-aborted request returned `aborted` and sent no request to the server. Live in-flight cancellation and cloud inference remain unverified. |
| Live generation and grading | Partial pass | FreeToken refused connections from this environment. A model selected in Pi for the disposable run through the existing Ollama installation generated one synthetic exercise in 16.4 s and accepted a meaning-equivalent plain-form answer in 5.8 s. Both calls left the session entry count unchanged. The grading prompt was reduced for this probe and did not exercise the proposed runtime schema. |
| Anki import and deck comparison | Pass | AnkiConnect API v6 responded. `findCards` and `guiBrowse` returned identical card IDs for the 911 eligible and 784 mature Core 2000 cards. `cardsInfo` agreed with the maturity query at the 21-day threshold. Eligible-only retrieval took 1.28 s. The full deck scan took 3.60 s and the two Browser comparisons took 4.49 s. Only read operations and Browser searches were used. |
| Sudachi installation and morphology | Pass | Verified SudachiPy 0.6.11 and SudachiDict Core 20251022, installed by the user in the project-local CPython 3.14.10 x64 environment. Sudachi identified `書き` as `書く`, `まし` as `ます`, and `た` as a separate auxiliary in `手紙を書きました。`. Dictionary initialization in the corpus run was 26.0 ms. |
| Labeled vocabulary coverage | Pass on the probe corpus | 30/30 allowed and 30/30 disallowed cases, with zero false accepts and zero false rejects. All 60 checks took 2.28 ms in one initialized Python process. The controlled fixture whitelist exercised conjugation, unknown content, homophones, compounds, OOV names, particles, punctuation and empty lexical content. The probe used Mode C, exact surface and dictionary-form matches, and narrow grammar exemptions. This benchmark excludes process startup and does not characterize all analyzer ambiguity, approved aliases or multispan matching. |
| Three live generation trials | Fail on acceptance criterion | The baseline prompt produced 4/10, 4/10 and 0/10 after refills. A focused prompt with an example and refill diagnostics produced 8/10, 10/10 and 6/10. One of three reached ten, below the required two. Human review found semantic and naturalness issues in candidates that passed the deterministic checks. |
| Windows IME | Pass | The user verified that Windows Japanese IME works in Pi. The interactive Pi dialog also returned composed Japanese unchanged on Enter and with bracketed paste. Escape dismissed the dialog without an answer. |

### Verified deck mapping

| Deck and note type | Total cards | Eligible | Mature | Import policy |
| --- | ---: | ---: | ---: | --- |
| Core 2000, `Core 2000` | 2,007 | 911 | 784 | Use the vocabulary fields. All cards observed had template ordinal 0 and distinct note IDs. Eligible intervals ranged from 1 to 1,112 days. |
| Default | 0 | 0 | 0 | Empty. |
| Immersion Phrases, `Basic` | 27 | 23 | 2 | `Front` is an English cue and `Back` is Japanese phrase material. Exclude from the initial lexical whitelist until a whole-phrase policy exists. |

Use `Vocabulary-Kanji` for the written headword, `Vocabulary-Kana` for reading evidence, and `Vocabulary-Pos` and `Vocabulary-English` as lexical metadata. `Vocabulary-Furigana` contains reading markup such as `一[ひと]つ`. `Expression` and `Reading` are sentence fields. The scan found 911 nonblank headword fields, all unchanged by HTML parsing, NFC and trim. They yielded 895 distinct written forms, 768 among the mature cards, and 911 distinct headword/reading/POS/gloss records. Six repeated written forms had different readings. Preserve those distinct records behind the same written-form key and use kana as reading evidence. Do not promote readings to aliases automatically. Keep the Anki data in memory.

The enriched adapter reads `Vocabulary-Kana`, `Vocabulary-English` and `Expression` directly. The live read returned 911 usable values in each field. All 911 example sentences contained markup, as did eight English definitions. The adapter strips inline HTML and media, decodes common entities and uses only short examples as reference material. The initial seven foundational entries increased the whitelist from 895 to 898 distinct written forms.

Both sources use the same Sudachi Mode C gate. Single tokens match the written form or the analyzer's dictionary form. A listed fixed expression can also cover its exact text at matching token boundaries. That exception does not whitelist its independent parts or variants. The pinned analyzer resolved `来ました`, `探しませんでした` and other ordinary conjugations to known lemmas. Both Mode A and C resolve `きました` to the kana lemma `くる` and `さがしました` to `さがす`. Their normalized forms point to the associated kanji spellings, but normalization can conflate readings or homophones. Leave unlisted spellings rejected and add a known alternate spelling explicitly if desired. The analyzer test also checks that `気をつけて` can be whitelisted as a phrase without making standalone `気` known.

### Sudachi setup and remaining tests

No `PIP_*` or proxy environment overrides were set and none of the queried system, user, interpreter or virtual environment `pip.ini` files existed. A retry with pip isolated mode and the explicit PyPI index reproduced the package resolution error. Direct HTTPS to PyPI and its file host exposed the underlying socket failure. This is a network blocker. The installed Python has a compatible published wheel and requires no interpreter change. The maintained bindings are under `sudachi.rs/python`. [Maintained SudachiPy source](https://github.com/WorksApplications/sudachi.rs/tree/develop/python) · [SudachiPy 0.6.11 release files](https://pypi.org/project/SudachiPy/0.6.11/#files) · [Core dictionary 20251022 release files](https://pypi.org/project/sudachidict-core/20251022/#files)

The user installed both pinned wheels into `.venv` outside the sandbox, resolving the download blocker. No interpreter change was needed. Keep Milestone 2 gated on explicit approval.

### Live generation measurements

Pi 1.5.2 resolved its active model through `ctx.model` in a disposable session started with the user's configured default selection, which resolved to Qwen3.5 9B via Ollama for these measurements. The probe did not change user or project model settings. Each trial used a new seeded sample of 85 mature Core 2000 headwords, checked references against all 895 eligible written forms, targeted polite past, and allowed up to two refill calls. The registry requests left Pi session entry counts unchanged. An initial diagnostic request with a minimal-reasoning override hit the 120 s deadline and returned an aborted result. The measured runs omitted that override and used an 850-token cap. The diagnostic timeout is reported separately from the three-trial sets.

| Prompt | Trial | First-pass accepted | Final accepted | Parsed candidates across calls | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 1 | 2/10 | 4/10 | 26 | 12.88 s |
| Baseline | 2 | 0/10 | 4/10 | 22 | 13.47 s |
| Baseline | 3 | 0/10 | 0/10 | 20 | 16.48 s |
| Focused | 1 | 5/10 | 8/10 | 19 | 8.50 s |
| Focused | 2 | 6/10 | 10/10 | 16 | 5.52 s |
| Focused | 3 | 2/10 | 6/10 | 23 | 8.72 s |

The focused prompt moved first-pass yield from 2/30 (6.7%) to 13/30 (43.3%) and final prepared yield from 8/30 (26.7%) to 24/30 (80.0%). Across the focused run, 24 of 58 parsed candidates passed the lexical, schema, grammar-suffix and duplication checks. Its model calls took 0.92–4.25 s each and reported 54–319 output tokens. The baseline had one invalid batch envelope and one partial first-pass batch. Across both runs, target errors and unknown words were frequent. Some unknown spans came from analyzer segmentation or unapproved variants. The probe kept those rejections in place.

Manual review of the machine-accepted pairs found definitively unusable items in both runs. Examples include English adding a library to `生徒は本を読みました。`, inventing details about finding vegetables when the sentence describes looking for a greengrocer, and translating `下着` as pajamas. `車自転車ぶつかりました。` passed coverage and the suffix test despite missing particles. The focused run also produced faithful pairs such as “I forgot the name” with `名前を忘れました。`. The machine-accepted counts are upper bounds for quiz-ready yield. A lexical pass and a polite-past suffix do not establish equivalence or naturalness. Use these findings to evaluate the plan's proposed targeted linguistic verification before accepting the generation strategy.

### Qwen3 14B comparison

Selected `qwen3:14b` through Pi for this disposable comparison and verified that the probe used `ctx.model` for each request. No user or project model configuration was changed. The focused prompt, sampling quotas, Sudachi coverage gate, target rule and two-refill budget were reused. AnkiConnect was offline, so the probe read the closed collection with SQLite read-only immutable mode and matched the previously verified counts of 911 eligible cards, 784 mature cards and 895 written forms. The sampling category order differed from the live-AnkiConnect run, so the exact headword samples differ. The application architecture continues to use AnkiConnect.

| Trial | First-pass accepted | Final accepted | Parsed candidates across calls | Wall time |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 6/10 | 6/10 | 18 | 49.11 s |
| 2 | 0/10 | 8/10 | 23 | 34.76 s |
| 3 | 8/10 | 8/10 | 14 | 26.59 s |

Qwen3 14B passed 14/30 (46.7%) first-pass slots and filled 22/30 (73.3%) after refills, compared with 13/30 and 24/30 for the focused Qwen3.5 9B trials. None reached ten. Individual model calls took 4.37–31.73 s. One first-pass batch contained ten items that failed the schema. Other rejections came from unapproved vocabulary or duplicate prompts and references, including identical failed candidates on successive refills.

Manual review found both faithful pairs and clear failures among the machine accepts. “I found a clock” matched `時計を見つけました。`. “I took off the clothes” reversed the meaning of `服を着ました。`, and “I ate some food” was paired with `下着を食べました。` (“I ate underwear”). One batch repeatedly used `何かを`, reducing variety. The comparison supports retaining the strict lexical gate and treating semantic alignment and naturalness as separate acceptance checks.

### Selected model for the next benchmark

Use `gemma4:12b` as the model selected in Pi for subsequent benchmarks. This is a test choice. The extension still resolves Pi’s active model for each request. Run the three ten-exercise trials with the full merged vocabulary gate and up to two refills per trial. Record first-pass yield, final yield and latency, and audit the accepted pairs for fidelity, naturalness and target grammar. The milestone requires at least two trials to reach ten accepted exercises. Keep Milestone 2 gated on the user's explicit approval.

### Running the benchmark in Pi

Open Anki with the Core 2000 deck available and AnkiConnect running. In PowerShell, start Pi with `Set-Location D:\Scripting\japanese-study` followed by `pi.cmd --approve --no-session`. Inside Pi, use `/model` to select `gemma4:12b`, then run `/study-benchmark`. The project-local probe reads Anki once, uses the existing `.venv` and opens a report with per-trial yield, model-call times, rejections and accepted pairs. Audit each accepted pair in that report and press Escape to close it. The benchmark uses fixed, reproducible samples with the same quotas as the earlier probes. Its shuffle differs from the original Python probe.

The benchmark reports deterministic first-pass acceptance against returned Japanese candidates and yield against the ten requested slots. It reports AI acceptance against translated pairs sent for review. An empty denominator is shown as unavailable. The report includes stage-specific rejections, accepted counts, inference calls and separate stage and elapsed times. Each trial also reports distinct accepted headwords, content headwords, identifiable main verbs, the most repeated words and patterns, exact Japanese and English duplicates, near-duplicate candidates, and preferred-target sentence counts and abandonments. Run `/study-benchmark translator` to translate six fixed Japanese sentences with audit notes. Run `/study-benchmark validator` for 24 labeled pair checks. The focused modes use one inference call each and can run with Anki closed.

Append `--debug` to any benchmark mode to show an **Inference debug** section at the end of the results editor. It lists each model call's stage, selected model, stop reason, output token cap, any inference error, full input prompts and response text before JSON parsing. An empty response is labeled explicitly, and terminal control characters are shown as escapes. The trace is held in memory for the report and stays out of the Pi conversation.

### Situation-driven generation and adaptive refills

The generation prompt treats the whitelist, grammar, grammatical accuracy, and JSON schema as requirements. It ranks idiomatic Japanese and meaningful everyday communication ahead of diversity and optional target coverage. The author privately considers an everyday situation. Its response contains only Japanese sentences, and translation receives only the surviving Japanese and identifiers.

Initial target ranking favors fully covered examples with past-style endings and supporting words already in the sample. A preferred target used in an accepted exercise is satisfied. A target with one attributable rejection moves behind unused targets with no such rejection. Two distinct sentences rejected for the same explicitly implicated Japanese headword remove it from the preferred list on the next refill. The headword stays available in the vocabulary. Translation-only errors, unassigned feedback, timeouts and malformed responses carry no attribution. An abandoned target can still occur in a valid sentence.

Morphology counts accepted content-word occurrences and identifies the terminal main verb where the token sequence is straightforward. Some chains and split predicates are omitted from the main-verb count. Refills receive bounded lists of covered and repeated content, verbs, and morphological patterns. Near-duplicate counts flag deterministic survivors that match an earlier survivor's part-of-speech and particle frame with at most one lexical slot changed, or that use the same lexical slots and differ only by topic marking. These are approximate diversity signals. Exact duplicate checks continue to reject repeats.

The independent reviewer receives the complete inflected verb when Sudachi corroborates a contiguous polite-past verb and auxiliary sequence. The requested inflection applies to the main clause, and a subordinate clause can contain a grammatical plain-form verb. The reviewer evaluates usage, time reference, collocations, Japanese and English accuracy, and whether the sentence stands on its own. Optional word attribution relies on the reviewer identifying the issue and naming a headword present in the analyzed sentence. The reviewer can miss both quality issues and their attribution.

The three seeded trials, ten slots per trial, two refills, sampling quotas, full whitelist and existing inference stages provide the benchmark baseline. The prompts, preferred-target ranking, refill data and focused reviewer fixtures changed. Run `/reload` in Pi, select the intended model with `/model`, then run `/study-benchmark` or `/study-benchmark --debug`.

All 14 automated tests passed with `node --test .pi/extensions/study-benchmark/*.test.ts`. The added checks cover Sudachi verb-form evidence, near-duplicate detection, target deprioritization and abandonment, and eligibility after infrastructure or response failures. The focused live validator scored 21/24 with local Gemma 4 12B in 5.65 s. It passed all five newly added cases, including the valid past decision about tomorrow and the valid subordinate plain form. It still accepted `売り場` as a whole store, `忘れ物` as a wallet, and `火事が消えました` as a natural fire collocation.

The live three-trial run used the Pi command handler with a headless UI harness, the real model registry, and 911 read-only Anki records. It finished with 28/30 exercises in 35.45 s across 25 inference calls. One trial reached ten accepted exercises, below the two-trial milestone threshold.

| Trial | First-pass deterministic | First-pass AI | Final | Distinct content headwords | Identifiable main verbs | Near-duplicate candidates |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 8/10 | 7/8 | 9/10 | 24 | 9 | 0 |
| 2 | 6/10 | 5/6 | 10/10 | 19 | 7 | 1 |
| 3 | 10/10 | 9/10 | 9/10 | 18 | 8 | 1 |

No exact duplicates were observed in this run. Trial 3 dropped `明日` from the second refill after two attributed time-reference rejections. The model still accepted questionable pairs such as “The office became vacant” for `会社が空きました。`. It also rejected `今夜` with past tense where the time of speaking could support that reading. The sample establishes that the changes work through the pipeline. Repeated runs across models would be needed to establish a sustained improvement in linguistic quality.

### Gemma 26B generation schema investigation

The saved debug report contains nine normal stops and 90 parseable candidate objects (66 distinct Japanese strings). Every object satisfied the old sentence, field count and grammar metadata checks. Every ID included a decimal point, while the parser required one to eight digits. One batch ended with `"1.0"`. JSON parsing succeeded and all 90 failed the ID check before linguistic evaluation. Some outputs, including `緑が綺麗でした。`, also missed the required polite-past verb construction.

The author now supplies only `{"sentences":["本を読みました。"]}`. Refills receive format feedback where applicable, rejected sentences with lexical, grammar or review reasons, and the targets still unused in accepted exercises. Debug traces include field paths, expectations and received values for schema failures, JSON parser errors and explicit truncation diagnostics.

In a read-only scan of the current merged snapshot, 210 of 895 distinct Anki examples passed full morphological coverage. Example selection omits all others. Selecting a covered example can bring supporting words from the full pool into the compact prompt. Support selection never adds entries to the whitelist.

The seeds (81–83), base sample quotas, ten slots, two refills, inference limits and acceptance threshold are unchanged. Target selection, prompts, examples, and generation output size have changed, affecting both yield and latency. Total elapsed time includes building the example index. All 11 regression tests passed, including the observed dotted-ID envelope, stable IDs through refill and review, invalid candidate diagnostics, and known-example support selection. A fresh end-to-end 26B result is pending. Open Anki, launch Pi in this workspace, select the desired model with `/model` and run `/study-benchmark --debug`. In an existing session, reload the extension with `/reload` first.

### Gemma 4 12B benchmark before AI review

Verified the project-local command end to end with live AnkiConnect, Sudachi and `gemma4:12b` selected in a disposable Pi session. Its isolated calls left Pi session entries unchanged.

| Trial | First-pass accepted | Final accepted | Wall time |
| --- | ---: | ---: | ---: |
| 1 | 10/10 | 10/10 | 13.93 s |
| 2 | 8/10 | 8/10 | 5.16 s |
| 3 | 10/10 | 10/10 | 2.96 s |

Two trials reached ten machine-accepted items. Both refills in trial 2 returned duplicates. Manual review found mismatches in both full trials. For example, “I read the news” was paired with `人気を読みました。`, and “I listened to the voice” with `顔を見ました。`. Keep the automated threshold result separate from the count of usable exercises when reviewing future runs. No Milestone 2 work began.

### Independent reviewer implementation and tests

`generation.ts` owns the author prompt, deterministic gate, review contract, refill bookkeeping and metrics. It takes inference and morphology functions and has no Pi dependency. The Pi adapter resolves the selected model for each call and sends a new system instruction and one JSON data message. The reviewer receives only the current survivors and their target, with no tools or earlier messages. Temporary test sessions used the selected `gemma4:12b` model and verified that the isolated calls left Pi session entries unchanged.

The reviewer accepts a bare JSON object or one JSON-only Markdown fence because the live model sometimes wraps its response. It accepts an integer ID only when it exactly matches a supplied decimal ID and treats a rejection reason as mandatory on a rejection. Missing, duplicate and unknown IDs, invalid decisions and broken envelopes admit zero exercises from that review. The author is told not to repeat those withheld pairs during refills.

All four deterministic regression tests passed at that stage. They covered malformed reviews, JSON fences, isolation of reviewer inputs, deterministic and AI gates on refills, and repeat handling after a failed review. In that focused live run, Gemma accepted all three valid pairs, rejected all three semantic mismatches and both Japanese grammar/target errors, and missed one English agreement error. Result was 8/9 in 1.95 s using one batched inference call.

### Gemma 4 12B benchmark with independent review

The live run used the same 911 eligible Anki cards, 895 written forms, three fixed samples and two-refill limit as the earlier project-local Gemma benchmark.

| Trial | First-pass deterministic | First-pass AI | Final accepted | Generation | Review | Elapsed | Inference calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 6/10 | 5/6 | 10/10 | 6.09 s | 2.80 s | 9.48 s | 6 |
| 2 | 6/10 | 4/6 | 8/10 | 7.24 s | 47.15 s | 54.84 s | 6 |
| 3 | 9/10 | 8/9 | 10/10 | 4.14 s | 2.06 s | 6.58 s | 4 |

Final automated yield was 28/30, with two full trials, 16 inference calls and 72.19 s elapsed including Anki setup. One review timed out after 45 s and admitted none of its six candidates. Other reviewer calls took 0.52–1.44 s. The reviewer caught mismatched directions such as “arrived” paired with `出ました`. It still let “The news was heard” through for `話が聞こえました。`, and accepted awkward pairs such as “I sat in the town” with `町に座りました。`. The result meets the automated threshold and remains short of a clean manual audit.

### Japanese-first generation and translation test results

All nine automated tests passed with `node --test .pi/extensions/study-benchmark/generation.test.ts .pi/extensions/study-benchmark/vocabulary.test.ts`. They exercise serialized vocabulary edits, duplicate and alternative-sense handling, the pinned Sudachi bridge, exact expression coverage, independent payloads, response schema checks and failure handling through refills.

On warm `gemma4:12b`, the translator produced faithful English on all six fixed Japanese inputs in 1.22 s. It used “sales floor” for `売り場`, kept `忘れ物` unspecified, and translated `町を忘れました` without adding a town name. The reviewer scored 17/19 in 3.75 s. It accepted all six valid pairs and rejected five of the seven prior failure cases. It still accepted “I went to the store” for `売り場へ行きました。` and “The fire went out” for `火事が消えました。`. The first focused attempts each hit the 45-second deadline. Subsequent attempts completed without changing the model or deadline.

| Trial | First-pass deterministic | First-pass AI | Final | Japanese generation | English translation | AI review | Elapsed | Calls | Distinct accepted headwords |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7/10 | 6/7 | 6/10 | 6.53 s | 1.71 s | 1.97 s | 10.77 s | 7 | 17 |
| 2 | 7/10 | 6/7 | 9/10 | 6.43 s | 2.13 s | 1.56 s | 10.58 s | 8 | 15 |
| 3 | 6/10 | 5/6 | 8/10 | 7.51 s | 1.71 s | 1.61 s | 11.28 s | 7 | 16 |

The final run finished in 34.20 s with 22 inference calls and accepted 23 of the 30 requested slots. It skipped translation on two batches with no deterministic survivors and skipped review on a batch whose only English prompt was a duplicate. Unknown forms such as `手帳` and `タクシー`, repeated Japanese sentences and target mismatches accounted for most lost slots. The reported repeated targets were `この間` twice in trial 1, `行く` three times and `花` twice in trial 2, and `お母さん` twice in trial 3. The reviewer also rejected a defensible translation, “I wrote in my diary” for `日記を書きました。`, so review can both over-reject and miss flaws. No trial reached ten. The vocabulary was left as explicitly approved while testing.

## Open decisions and implementation gates

| Risk or assumption | How to resolve it |
| --- | --- |
| Deck layout and eligibility | Confirm deck, subdeck scope, note field formats and which card direction counts as known during milestone 1. Check whether mature-only or all eligible review cards better match productive recall. |
| Sudachi errors and packaging | Test the pinned Windows interpreter and dictionary pair, plus native analyzer output on real deck entries. Compare a JS tokenizer only if the baseline fails coverage or setup. Add narrow allowances based on labeled cases. |
| Grammar scope | Confirm which concepts are already known and which are targets. Start with checkable patterns. Track model-authored grammar leakage and decide whether an additional verification step earns its latency. |
| Translation ambiguity and grader consistency | Review real reference pairs and run several valid alternatives through the grader. Add visible context or an explicit grammar constraint where appropriate. Allow uncertainty and skip. |
| Model compatibility and latency | Verify live selection, model switching, isolated calls, abort and timeout, and valid structured replies. Measure latency and acceptance yield on the selected model. |

The AnkiConnect upstream repository advertises its move to SourceHut, which was inaccessible to the research browser. API details were cross-checked in the upstream archive and the community fork documentation. Treat the installed add-on contract as a milestone 1 check. [Move notice](https://github.com/FooSoft/anki-connect) · [Current upstream location](https://git.sr.ht/~foosoft/anki-connect)

### Controlled vocabulary expansion

The current benchmark supersedes the strict generated-sentence vocabulary rule documented in earlier milestones. Eligible Anki entries and the editable foundational file define known vocabulary. The generator prioritizes these and may introduce common, practical words to support natural communication. Edit `data/vocabulary-expansion.json` to set the integer maximum percentage (default 20) and unique unconfirmed dictionary forms per exercise (default one).

Sudachi identifies dictionary-backed content tokens outside the known pool. Unknown grammatical tokens, proper nouns, numerals, OOV tokens and uncovered spans continue to fail. Repeated uses of an unconfirmed lemma count once per exercise. The independent reviewer evaluates appropriateness and supplies a kana dictionary-form reading and contextual English gloss for each unconfirmed lemma. Metadata is held in memory and shown alongside the accepted sentence. Readings, glosses and judgments of learner level depend on model accuracy.

Known-only survivors take priority within each request. Quality-approved expanded candidates wait across refills until enough known-only exercises qualify. With the defaults, four known-only exercises support one expanded exercise, and eight support two. The denominator is the actual final exercise count. Excess pending candidates count as final expansion-limit rejections. Existing benchmark stage logs show individual per-exercise limit rejections. Earlier strict-gate yields use a different acceptance policy.
