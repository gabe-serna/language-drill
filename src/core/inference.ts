type InferenceRequest = { systemPrompt: string; data: object; maxTokens: number };
export type Inference = (request: InferenceRequest) => Promise<{ text: string; stop: string }>;

export async function requestInference(infer: Inference, request: InferenceRequest) {
  if (typeof request.systemPrompt !== "string" || !request.systemPrompt.trim() ||
      !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 ||
      !request.data || typeof request.data !== "object" || Array.isArray(request.data)) {
    throw new Error("Invalid inference request.");
  }
  const reply = await infer(request);
  if (!reply || typeof reply.text !== "string" || typeof reply.stop !== "string" || !reply.stop) {
    throw new Error("Invalid inference response.");
  }
  return reply;
}
