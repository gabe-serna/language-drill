import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Inference } from "../../../src/core/inference.ts";

function deadline(ms: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type InferenceTrace = {
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

export function inference(ctx: ExtensionCommandContext, signal?: AbortSignal, traces?: InferenceTrace[], label = () => "study"): Inference {
  return async ({ systemPrompt, data, maxTokens }) => {
    const model = ctx.model;
    if (!model) throw new Error("Pi no longer has a selected model.");
    const userMessage = JSON.stringify(data);
    const trace: InferenceTrace | undefined = traces ? { label: label(), model: model.id, systemPrompt, userMessage, maxTokens } : undefined;
    if (trace) traces?.push(trace);
    const entries = ctx.sessionManager.getEntries().length;
    const requestSignal = deadline(45_000, signal);
    const reply = await ctx.modelRegistry.streamSimple(model, {
      systemPrompt,
      messages: [{ role: "user", timestamp: Date.now(), content: userMessage }],
    }, { signal: requestSignal, maxTokens }).result().catch(error => {
      if (trace) trace.error = error instanceof Error ? error.message : String(error);
      requestSignal.throwIfAborted();
      throw error;
    });
    const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
    if (trace) Object.assign(trace, { text, stop: reply.stopReason, error: reply.errorMessage });
    requestSignal.throwIfAborted();
    if (entries !== ctx.sessionManager.getEntries().length) {
      throw new Error("Pi session entries changed during an isolated model request.");
    }
    return { text, stop: reply.stopReason };
  };
}
