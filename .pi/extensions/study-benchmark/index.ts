import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildVocabularyGate, generateTrial, translateBatch, validateBatch, type Inference, type Token } from "./generation.ts";
import { indexKnownExamples, mergeVocabulary, readFoundationalVocabulary, selectPracticeVocabulary } from "./vocabulary.ts";
import { loadAnkiVocabulary } from "./anki.ts";
import { translationCases, validatorCases } from "./validator-cases.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const analyzer = fileURLToPath(new URL("./analyze.py", import.meta.url));
const foundationalPath = join(root, "data", "foundational-vocabulary.json");
function analyze(lines: string[]): Promise<Token[][]> {
  return new Promise((resolve, reject) => {
    const python = join(root, ".venv", "Scripts", "python.exe");
    const proc = spawn(python, [analyzer], {
      windowsHide: true, signal: AbortSignal.timeout(10_000), stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
    proc.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
    proc.on("error", reject);
    proc.stdin.on("error", reject);
    proc.on("close", code => {
      try {
        if (code !== 0) throw new Error("Sudachi failed: " + stderr.trim().slice(0, 250));
        const result = JSON.parse(stdout) as Token[][];
        if (!Array.isArray(result) || result.length !== lines.length) throw new Error("Invalid Sudachi result");
        resolve(result);
      } catch (error) { reject(error); }
    });
    proc.stdin.end(JSON.stringify(lines), "utf8");
  });
}

const seconds = (ms: number) => (ms / 1000).toFixed(2) + " s";
const rate = (passed: number, total: number) => total ? `${passed}/${total} (${(100 * passed / total).toFixed(1)}%)` : "n/a (0 candidates)";
const visibleText = (text: string) => text.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g,
  char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

type InferenceTrace = {
  label: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  text?: string;
  diagnostics?: string[];
  stop?: string;
  error?: string;
};

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
      const modes = tokens.filter(token => token !== "--debug");
      const [mode = ""] = modes;
      if (modes.length > 1 || (mode && mode !== "validator" && mode !== "translator")) {
        ctx.ui.notify("Usage: /study-benchmark [validator|translator] [--debug]", "warning");
        return;
      }
      const debug = tokens.includes("--debug");
      running = true;
      const report: string[] = [];
      const traces: InferenceTrace[] = [];
      let label = mode || "benchmark";
      const show = (title: string) => ctx.ui.editor(title + " (Esc to close)", report.join("\n") + formatDebug(traces));
      const diagnostic = debug ? (message: string) => { (traces[traces.length - 1].diagnostics ??= []).push(message); } : undefined;
      const infer: Inference = async ({ systemPrompt, data, maxTokens }) => {
        const model = ctx.model;
        if (!model) throw new Error("Pi no longer has a selected model.");
        const userMessage = JSON.stringify(data);
        const trace: InferenceTrace | undefined = debug ? { label, model: model.id, systemPrompt, userMessage, maxTokens } : undefined;
        if (trace) traces.push(trace);
        const entries = ctx.sessionManager.getEntries().length;
        const reply = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt,
          messages: [{ role: "user", timestamp: Date.now(), content: userMessage }],
        }, { signal: AbortSignal.timeout(45_000), maxTokens }).result().catch(error => {
          if (trace) trace.error = error instanceof Error ? error.message : String(error);
          throw error;
        });
        const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
        if (trace) Object.assign(trace, { text, stop: reply.stopReason, error: reply.errorMessage });
        if (entries !== ctx.sessionManager.getEntries().length) {
          throw new Error("Pi session entries changed during an isolated model request.");
        }
        return { text, stop: reply.stopReason };
      };
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
        const anki = await loadAnkiVocabulary();
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
          const started = Date.now();
          const { vocabulary, targets } = selectPracticeVocabulary(entries, 80 + trial, examples);
          const result = await generateTrial({
            vocabulary, targets, gate, analyze, infer, expansionPolicy, report: diagnostic,
            onCall: (stage, attempt) => {
              label = `Trial ${trial}/3 · ${stage} ${attempt}/3`;
              ctx.ui.setStatus("study-benchmark", label);
            },
          });
          const first = result.calls[0];
          const trialCalls = result.calls.reduce((sum, call) => sum + 1 + Number(call.translated) + Number(call.reviewed), 0);
          inferenceCalls += trialCalls;
          if (result.accepted.length === 10) fullTrials++;
          report.push("", `Trial ${trial}: first-pass deterministic ${rate(first.deterministicAccepted, first.candidates)} (${first.deterministicAccepted}/10 requested), AI ${rate(first.aiAccepted, first.reviewedCandidates)}; final ${result.accepted.length}/10`);
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
        report.push("", `Total elapsed: ${seconds(Date.now() - benchmarkStarted)}; ${inferenceCalls} inference calls`);
        report.push("", `Automated threshold: ${fullTrials}/3 full trials (need 2). Review each pair for meaning, natural Japanese and polite past.`);
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
