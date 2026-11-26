import { allocate, levels } from "../../../src/core/grammar.ts";
import { voicevox, type Settings } from "../../../src/adapters/voicevox.ts";
import { wrapTextWithAnsi, matchesKey } from "@earendil-works/pi-tui";
import { gradeAnswer, explainAnswer, type Grade } from "../../../src/core/grading.ts";
import { inference, type InferenceTrace } from "./inference.ts";
import { loadGrammar } from "../../../src/adapters/config.ts";
import { analyze } from "../../../src/adapters/sudachi.ts";
import { sessionAudio } from "../../../src/core/audio.ts";
import { playWave } from "../../../src/adapters/windows-playback.ts";
import { prepareQuestions } from "../../../src/core/prepare.ts";
import { studyCommand, studyCompletions } from "./commands.ts";
import { addFoundationalEntry, readFoundationalVocabulary } from "../../../src/adapters/foundational.ts";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formDistribution, buildVocabularyGate, finalizeExpansion, generateTrial, translateBatch, validateBatch } from "../../../src/core/generation.ts";
import { indexKnownExamples, mergeVocabulary, selectPracticeVocabulary } from "../../../src/core/vocabulary.ts";
import { loadAnkiVocabulary } from "../../../src/adapters/anki.ts";
import { translationCases, validatorCases } from "./validator-cases.ts";

import { runQuestions, summary } from "../../../src/core/session.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const foundationalPath = join(root, "data", "foundational-vocabulary.json");
const seconds = (ms: number) => (ms / 1000).toFixed(2) + " s";
const rate = (passed: number, total: number) => total ? `${passed}/${total} (${(100 * passed / total).toFixed(1)}%)` : "n/a (0 candidates)";
const visibleText = (text: string) => text.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g,
  char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

function formatDebug(traces: InferenceTrace[]) {
  if (!traces.length) return "";
  return "\n\n=== Inference debug ===\n" + traces.map((trace, index) => visibleText([
    `--- Call ${index + 1}: ${trace.label} · ${trace.model} ---`,
    `Stop: ${trace.stop ?? "request failed"} · output token cap: ${trace.maxTokens}`,
    ...(trace.error ? ["Error: " + trace.error] : []),
    ...(trace.diagnostics ?? []),
    "System prompt:", trace.systemPrompt,
    "Full user message:", trace.userMessage,
    "Raw model response:", trace.text || "(no model text)",
  ].join("\n"))).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  let running = false;
  pi.registerCommand("study", {
    description: "Open the study menu or start drilling [--q <count>]",
    getArgumentCompletions: studyCompletions,
    async handler(args, ctx) {
      if (realpathSync(ctx.cwd).toLowerCase() !== realpathSync(root).toLowerCase()) return;
      if (running || !ctx.hasUI || !ctx.isIdle()) {
        ctx.ui.notify("Study needs an idle interactive Pi session.", "warning");
        return;
      }
      running = true;
      const controller = new AbortController();
      const signal = controller.signal;
      // Keep Escape available while external services run. Close the dialog before showing the next screen.
      async function prepare<T>(title: string, work: () => Promise<T>, cancellation = controller) {
        const dialog = new AbortController();
        const closed = ctx.ui.select(title, ["Cancel"], { signal: dialog.signal }).then(() => {
          if (!dialog.signal.aborted) cancellation.abort();
        });
        try {
          const result = await work();
          cancellation.signal.throwIfAborted();
          return result;
        } finally {
          dialog.abort();
          await closed;
        }
      }
      let audio: ReturnType<typeof sessionAudio> | undefined;
      let autoPlay = false;
      const tokens = args.trim().split(/\s+/);
      const traces: InferenceTrace[] | undefined = tokens.includes("--debug") ? [] : undefined;
      try {
        const catalog = loadGrammar(join(root, "data", "grammar.json"));
        let options = studyCommand(tokens.filter(token => token !== "--debug").join(" "));
        const { entries, menu } = await prepare("Loading study vocabulary", async () => {
          const [anki, foundational] = await Promise.all([loadAnkiVocabulary(signal, options?.recent), readFoundationalVocabulary(foundationalPath)]);
          const entries = mergeVocabulary(anki.entries, foundational);
          const known = new Set(entries.map(item => item.headword)).size;
          return { entries, menu: `Study | ${anki.count} eligible cards | ${foundational.length} foundational entries | ${known} known headwords | Grammar: ${catalog.entries.length} enabled | Difficulty: easy, medium, hard or mixed | --recent available` };
        });
        if (!options) {
          const choice = await ctx.ui.select(menu, ["/study drilling --q 10 (mixed)", ...levels.map(level => "/study drilling --difficulty " + level), "Exit"]);
          if (!choice || choice === "Exit") return;
          options = studyCommand(choice.replace("/study ", "").replace(" (mixed)", ""))!;
        }
        const { count: requested, difficulty, recent } = options;
        const questions = await prepare("Preparing exercises (Esc to exit)", async () => {
          return prepareQuestions({ entries, catalog, requested, difficulty, recent, signal,
            tokenize: lines => analyze(lines, signal), infer: inference(ctx, signal),
            expansionPolicy: JSON.parse(readFileSync(join(root, "data", "vocabulary-expansion.json"), "utf8")),
            onProgress(prepared, tier, stage, attempt) {
              ctx.ui.setStatus("study", `Prepared ${prepared}/${requested} | ${tier} | ${stage} | attempt ${attempt}/3`);
            },
          });
        });
        ctx.ui.setStatus("study", undefined);
        if (questions.length < requested) ctx.ui.notify(`Prepared ${questions.length} of ${requested} requested exercises within the retry limit.`, "warning");
        if (!questions.length) return;
        const feedback = (grade?: Grade) => grade
          ? [({ correct: "Correct", partially_correct: "Partially correct", incorrect: "Incorrect" })[grade.verdict],
            grade.feedback, ...grade.errors.map(error => "- " + error)].join("\n")
          : "";
        try {
          const settings: Settings = JSON.parse(readFileSync(join(root, "data", "voicevox.json"), "utf8"));
          const synthesize = voicevox(settings);
          if (settings.enabled) audio = sessionAudio(synthesize, playWave);
          autoPlay = settings.autoPlay;
        } catch { ctx.ui.notify("Reference audio unavailable. Check data/voicevox.json.", "warning"); }
        const result = await runQuestions(questions, {
          known: new Set(entries.map(entry => entry.headword)),
          analyze: lines => analyze(lines, signal),
          confirm: entry => ctx.ui.custom<"yes" | "no" | "skip">((_tui, theme, keys, done) => ({
            invalidate() {},
            render: width => [theme.fg("accent", "Unconfirmed vocabulary"), "",
              visibleText(entry.headword + "（" + entry.reading + "）— " + entry.meaning), "",
              "Did you already know this word?", "[Y] Yes    [N] No    [S] Skip"].flatMap(line => wrapTextWithAnsi(line, width)),
            handleInput(data) {
              if (data.toLowerCase() === "y") done("yes");
              else if (data.toLowerCase() === "n") done("no");
              else if (data.toLowerCase() === "s" || keys.matches(data, "tui.select.cancel")) done("skip");
            },
          })),
          async save(entry) {
            await addFoundationalEntry(foundationalPath, entry);
            entries.push(...mergeVocabulary([], [entry]));
          },
          error: message => ctx.ui.notify(message, "warning"),
          begin: question => audio?.preload(question.referenceJa),
          async answer({ prompt, draft, attempts, failure, hint, remaining }) {
            const [title, ...english] = prompt.split("\n");
            const choices = [draft ? "Edit and submit" : "Enter Answer", hint ? "Hide Hint" : "Show Hint", "Give Up", "Exit"];
            const choice = await ctx.ui.custom<number>((tui, theme, keys, done) => {
              let selected = 0;
              return {
                invalidate() {},
                render(width) {
                  const lines = [theme.fg("accent", title.toUpperCase()), visibleText(english.join("\n")), "",
                    ...(hint ? [theme.fg("accent", "Hint:"), visibleText(hint), ""] : []),
                    theme.fg("muted", "─".repeat(Math.max(0, width))), theme.italic(theme.fg("muted", remaining + " attempts remaining")),
                    feedback(attempts.at(-1)?.grade), failure ? failure + " Your draft is ready to retry." : "",
                    ...choices.map((name, i) => selected === i ? theme.fg("accent", "→ " + name) : "  " + name)];
                  return lines.flatMap(line => wrapTextWithAnsi(line, width));
                },
                handleInput(data) {
                  if (keys.matches(data, "tui.select.cancel")) return done(3);
                  if (keys.matches(data, "tui.select.confirm")) return done(selected);
                  if (keys.matches(data, "tui.select.up")) selected = (selected + 3) % 4;
                  if (keys.matches(data, "tui.select.down")) selected = (selected + 1) % 4;
                  tui.requestRender();
                },
              };
            });
            if (choice === 1) return { action: "hint" };
            if (choice === 2) return { action: "give_up" };
            if (choice === 3) return { action: "exit" };
            const answer = await ctx.ui.editor(prompt, draft);
            return answer === undefined ? { action: "exit" } : { action: "submit", answer };
          },
          async grade(question, answer, attemptsRemainingAfterSubmission) {
            const grading = new AbortController();
            try {
              return await prepare("Grading answer (Esc to cancel)", () =>
                gradeAnswer(inference(ctx, grading.signal, traces, () => "grading"), question, answer, attemptsRemainingAfterSubmission), grading);
            } catch (error) {
              const message = grading.signal.aborted ? "Grading cancelled." :
                error instanceof Error && error.name === "TimeoutError" ? "Grading timed out." :
                error instanceof Error ? error.message : "Grading inference failed.";
              if (traces?.length) traces[traces.length - 1].diagnostics = [message];
              throw new Error(message);
            }
          },
          async reveal(question, outcome, lastGrade, answer) {
            const explaining = new AbortController();
            try {
              return await ctx.ui.custom<boolean>((tui, theme, keys, done) => {
                let firstRender = true;
                let failedSpeed: boolean | undefined;
                const replay = (slow = false) => {
                  failedSpeed = undefined;
                  audio?.replay(question.referenceJa, () => { failedSpeed = slow; tui.requestRender(); }, slow);
                };
                let expanded = false;
                let points = ["Preparing breakdown…"];
                let selected = 0;
                // Start once per completed question. Visibility changes only affect rendering.
                void explainAnswer(inference(ctx, explaining.signal, traces, () => "breakdown"), question)
                  .then(result => { points = result; }, () => { points = ["Breakdown unavailable."]; })
                  .finally(() => { if (!explaining.signal.aborted) tui.requestRender(); });
                return {
                  invalidate() {},
                  render(width) {
                    if (firstRender && autoPlay) queueMicrotask(() => { if (!explaining.signal.aborted) replay(); });
                    firstRender = false;
                    const verdict = lastGrade?.verdict;
                    const label = verdict === "correct" ? "Correct" : verdict === "partially_correct" ? "Partially correct" : verdict ? "Incorrect" : "Gave up";
                    const color = verdict === "correct" ? "success" : verdict === "partially_correct" ? "warning" : verdict ? "error" : "muted";
                    const lines = [theme.fg(color, label), ...(answer ? [visibleText(answer)] : []), "",
                      theme.fg("muted", "Reference"), theme.fg("accent", visibleText(question.referenceJa)), theme.italic(theme.fg("muted", visibleText(question.english))), "",
                      ...(lastGrade ? [lastGrade.feedback, ...lastGrade.errors] : []),
                      ...(outcome === "gave_up" && verdict ? [theme.fg("muted", "Gave up")] : []),
                      "", theme.fg("muted", expanded ? "[E] Hide breakdown" : "[E] Show breakdown"),
                      ...(audio ? [theme.fg("muted", failedSpeed === false ? "[P] Replay Audio (unavailable)" : "[P] Replay Audio"), theme.fg("muted", "[L] Replay Audio (slow)" + (failedSpeed === true ? " (unavailable)" : ""))] : []),
                      ...(expanded ? points : []), "", ...["Continue", "Exit"].map((name, i) => (selected === i ? "→ " : "  ") + name)];
                    return lines.flatMap(line => wrapTextWithAnsi(line, width));
                  },
                  handleInput(data) {
                    if (keys.matches(data, "tui.select.cancel")) return done(false);
                    if (keys.matches(data, "tui.select.confirm")) return done(selected === 0);
                    if (matchesKey(data, "e") || matchesKey(data, "shift+e") || data === "E") expanded = !expanded;
                    else if (data.toLowerCase() === "l") replay(true);
                    else if (matchesKey(data, "p") || matchesKey(data, "shift+p") || data === "P") replay();
                    else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) selected = 1 - selected;
                    tui.requestRender();
                  },
                };
              });
            } finally { explaining.abort(); audio?.stop(); }
          },
        });
        await ctx.ui.select((result.completed ? "Study complete" : "Study ended") + "\n" + summary(result), ["Done"]);
      } catch (error) {
        ctx.ui.notify(signal.aborted ? "Study cancelled." : String(error), signal.aborted ? "info" : "error");
      } finally {
        controller.abort();
        await audio?.close();
        ctx.ui.setStatus("study", undefined);
        try { if (traces?.length) await ctx.ui.editor("Study debug (Esc to close)", formatDebug(traces)); }
        finally { running = false; }
      }
    },
  });
  pi.registerCommand("study-benchmark", {
    description: "Run three generation trials or a focused test, with optional --debug",
    async handler(args, ctx) {
      if (realpathSync(ctx.cwd).toLowerCase() !== realpathSync(root).toLowerCase()) return;
      if (!ctx.hasUI || running || !ctx.isIdle()) {
        ctx.ui.notify("The benchmark needs an idle interactive Pi session.", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("Select a Pi model with /model first.", "warning");
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const modes = tokens.filter(token => token !== "--debug" && token !== "--recent");
      const [mode = ""] = modes;
      if (modes.length > 1 || (mode && !["validator", "translator", "mixed", ...levels].includes(mode))) {
        ctx.ui.notify("Usage: /study-benchmark [validator|translator|mixed|easy|medium|hard] [--recent] [--debug]", "warning");
        return;
      }
      const debug = tokens.includes("--debug");
      running = true;
      const report: string[] = [];
      const traces: InferenceTrace[] = [];
      let label = mode || "benchmark";
      const show = (title: string) => ctx.ui.editor(title + " (Esc to close)", report.join("\n") + formatDebug(traces));
      const diagnostic = debug ? (message: string) => { (traces[traces.length - 1].diagnostics ??= []).push(message); } : undefined;
      const infer = inference(ctx, undefined, debug ? traces : undefined, () => label);
      try {
        const benchmarkStarted = Date.now();
        const foundational = await readFoundationalVocabulary(foundationalPath);
        report.push("Selected Pi model: " + ctx.model.id);
        if (mode === "translator") {
          ctx.ui.setStatus("study-benchmark", "Translating the test sentences");
          const batch = await translateBatch(translationCases.map(({ sentence }) => sentence), infer, diagnostic);
          for (const { sentence, expected } of translationCases) {
            report.push(`${sentence.referenceJa}  |  ${batch.translations.get(sentence.id) ?? "no translation"}  |  Audit: ${expected}`);
          }
          if (batch.error) report.push(batch.error);
          report.push(`Translation ${seconds(batch.ms)}; 1 inference call`);
          await show("Translator test results");
          return;
        }
        if (mode === "validator") {
          ctx.ui.setStatus("study-benchmark", "Reviewing the validator test cases");
          const batch = await validateBatch(validatorCases.map(({ exercise }) => exercise), infer, diagnostic);
          let correct = 0;
          for (const { exercise, accepted } of validatorCases) {
            const decision = batch.decisions.get(exercise.id);
            const pass = decision?.accepted === accepted && !batch.error;
            if (pass) correct++;
            report.push(`${pass ? "PASS" : "FAIL"} ${exercise.id}: expected ${accepted ? "accept" : "reject"}; ${decision ? (decision.accepted ? "accepted" : decision.reason) : "no decision"}`);
          }
          if (batch.error) report.push(batch.error);
          report.push(`${correct}/${validatorCases.length} correct; review ${seconds(batch.ms)}; 1 inference call`);
          await show("Validator test results");
          return;
        }
        let inferenceCalls = 0;
        const catalog = loadGrammar(join(root, "data", "grammar.json"));
        const recent = tokens.includes("--recent") ? catalog.recent : undefined;
        const now = Date.now();
        const measureRecency = !!mode || !!recent;
        const anki = await loadAnkiVocabulary(undefined, measureRecency, !!recent);
        const tiers = mode ? allocate(10, catalog.distribution, levels.find(level => level === mode)) : [{ difficulty: undefined, count: 10 }];
        const entries = mergeVocabulary(anki.entries, foundational);
        const known = new Set(entries.map(item => item.headword));
        const gate = await buildVocabularyGate(known, analyze);
        report.push(`Core 2000: ${anki.count} eligible cards; ${foundational.length} foundational entries; ${known.size} merged written forms.`);
        report.push(`Anki enrichment: ${anki.entries.filter(item => item.reading).length} readings, ${anki.entries.filter(item => item.meaning).length} definitions, ${anki.entries.filter(item => item.exampleJa).length} short examples.`);
        const examples = await indexKnownExamples(entries, gate, analyze);
        report.push(`Fully covered distinct examples: ${examples.size}/${new Set(entries.map(item => item.exampleJa).filter(Boolean)).size}`);
        const expansionPolicy = JSON.parse(readFileSync(join(root, "data", "vocabulary-expansion.json"), "utf8"));
        let fullTrials = 0;
        for (let trial = 1; trial <= 3; trial++) {
          const all: Awaited<ReturnType<typeof generateTrial>>["accepted"] = [];
          const deferred: typeof all = [];
          for (const tier of tiers) {
            const started = Date.now();
            const { vocabulary, targets } = selectPracticeVocabulary(entries, 80 + trial, examples, recent, now);
            const result = await generateTrial({
              vocabulary, targets, gate, analyze, infer, expansionPolicy, report: diagnostic,
              size: tier.count, difficulty: tier.difficulty, grammarEntries: catalog.entries, previous: [...all, ...deferred],
              onCall: (stage, attempt) => {
                label = `Trial ${trial}/3 · ${stage} ${attempt}/3`;
                ctx.ui.setStatus("study-benchmark", label);
              },
            });
            const first = result.calls[0];
            const trialCalls = result.calls.reduce((sum, call) => sum + 1 + Number(call.translated) + Number(call.reviewed), 0);
            inferenceCalls += trialCalls;
            all.push(...result.accepted);
            deferred.push(...result.pending);
            const used = new Set(result.accepted.flatMap(item => item.used));
            const recentUsed = new Set(entries.filter(item => item.reviewedAt !== undefined &&
              now - item.reviewedAt < catalog.recent.windowDays * 86_400_000 && used.has(item.headword)).map(item => item.headword));
            report.push(`  Difficulty ${tier.difficulty ?? "legacy"}: ${result.accepted.length}/${tier.count}; refills ${result.calls.length - 1}`);
            const unexpected = result.calls.flatMap(call => Object.entries(call.aiRejections)
              .filter(([reason]) => /^Unexpected grammar:/i.test(reason)));
            if (unexpected.length) report.push("  Unexpected grammar: " + JSON.stringify(unexpected));
            if (measureRecency) report.push(`  Recently reviewed headwords used: ${recentUsed.size}/${used.size}`);
            report.push("", `Trial ${trial}: first-pass deterministic ${rate(first.deterministicAccepted, first.candidates)} (${first.deterministicAccepted}/${tier.count} requested), AI ${rate(first.aiAccepted, first.reviewedCandidates)}; final ${result.accepted.length}/${tier.count}`);
            report.push(`  Japanese generation ${seconds(result.calls.reduce((sum, call) => sum + call.generationMs, 0))}; English translation ${seconds(result.calls.reduce((sum, call) => sum + call.translationMs, 0))}; AI validation ${seconds(result.calls.reduce((sum, call) => sum + call.validationMs, 0))}; elapsed ${seconds(Date.now() - started)}; ${trialCalls} inference calls`);
            report.push(`  Unique accepted headwords: ${result.uniqueVocabulary}; content headwords: ${result.usage.uniqueContent}; identifiable main verbs: ${result.usage.uniqueMainVerbs}`);
            report.push("  Most repeated content headwords: " + JSON.stringify(result.usage.repeatedContent.slice(0, 10)));
            report.push("  Repeated main verbs: " + JSON.stringify(result.usage.repeatedMainVerbs));
            report.push("  Repeated morphological patterns: " + JSON.stringify(result.usage.repeatedPatterns));
            const coveredTargets = Object.values(result.targetUses).filter(uses => uses > 0).length;
            report.push(`  Preferred targets covered: ${coveredTargets}/${Object.keys(result.targetUses).length}; sentence counts: ${JSON.stringify(result.targetUses)}`);
            report.push("  Targets abandoned before refills: " + JSON.stringify(Object.fromEntries(result.abandonedTargets)));
            const duplicates = result.calls.reduce((total, call) => total + (call.deterministicRejections["duplicate Japanese"] ?? 0), 0);
            const englishDuplicates = result.calls.reduce((total, call) => total + (call.translationRejections["duplicate English"] ?? 0), 0);
            report.push(`  Exact duplicates: ${duplicates} Japanese, ${englishDuplicates} English; near-duplicate Japanese candidates flagged: ${result.calls.reduce((total, call) => total + call.nearDuplicates, 0)}`);
            for (const [i, call] of result.calls.entries()) {
              report.push(`  Request ${i + 1}: deterministic ${rate(call.deterministicAccepted, call.candidates)} (${call.requested} requested); AI ${rate(call.aiAccepted, call.reviewedCandidates)}; generation ${seconds(call.generationMs)}; translation ${call.translated ? seconds(call.translationMs) : "skipped"}; review ${call.reviewed ? seconds(call.validationMs) : "skipped"}`);
              report.push("    Deterministic rejections: " + JSON.stringify(call.deterministicRejections));
              report.push("    Translation rejections: " + JSON.stringify(call.translationRejections));
              report.push("    AI rejections: " + JSON.stringify(call.aiRejections));
              report.push(`    Accepted content headwords: ${call.usage.uniqueContent}; identifiable main verbs: ${call.usage.uniqueMainVerbs}; near-duplicates flagged: ${call.nearDuplicates}`);
              report.push("    Preferred-target sentence counts: " + JSON.stringify(call.targetUses));
            }
            const expanded = result.accepted.filter(item => item.words?.length);
            const knownOnly = result.accepted.length - expanded.length;
            report.push(`  Known-only: ${rate(knownOnly, result.accepted.length)}; expanded: ${expanded.length}; final percentage-limit rejections: ${result.expansionLimitRejections}`);
            for (const item of expanded) report.push(`  ${item.referenceJa} | ${JSON.stringify(item.words)}`);
            for (const item of result.accepted) report.push(`  ${item.english}  |  ${item.referenceJa}`);
          }
          const final = finalizeExpansion(all, deferred, expansionPolicy.maxPercent, 10);
          report.push("Grammatical forms and sentence types (surface estimates): " + JSON.stringify(formDistribution(final)));
          if (final.length === 10) fullTrials++;
          if (mode) {
            report.push(`Trial ${trial} final distribution: ` + tiers.map(tier =>
              `${tier.difficulty} ${final.filter(item => item.difficulty === tier.difficulty).length}/${tier.count}`).join(", "));
            const added = final.slice(all.length);
            for (const item of added) report.push(`  Added from session expansion budget (${item.difficulty}): ${item.english} | ${item.referenceJa}`);
            const grammarUses = new Map<string, number>();
            for (const item of final) for (const id of item.grammarIds ?? []) grammarUses.set(id, (grammarUses.get(id) ?? 0) + 1);
            report.push("  Final grammar coverage: " + JSON.stringify(Object.fromEntries(grammarUses)));
            report.push(`  Final expanded exercises: ${final.filter(item => item.words?.length).length}/${final.length}`);
          }
        }
        report.push("", `Total elapsed: ${seconds(Date.now() - benchmarkStarted)}; ${inferenceCalls} inference calls`);
        report.push("", `Automated threshold: ${fullTrials}/3 full trials (need 2). Review each pair for meaning, natural Japanese, and the requested grammar and difficulty.`);
        ctx.ui.setStatus("study-benchmark", undefined);
        await show("Study benchmark results");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (traces.length) {
          report.push("", "Benchmark stopped: " + message);
          await show("Study benchmark diagnostics");
        } else ctx.ui.notify(message, "error");
      } finally {
        ctx.ui.setStatus("study-benchmark", undefined);
        running = false;
      }
    },
  });
}
