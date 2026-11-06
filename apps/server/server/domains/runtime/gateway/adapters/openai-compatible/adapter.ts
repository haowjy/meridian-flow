/**
 * OpenAI-compatible (Chat Completions) provider adapter: implements the
 * provider-adapter port over any OpenAI-Chat-Completions-shaped endpoint
 * (gemini, mock, self-hosted). Owns the chat-completions streaming wiring. The
 * shared stream envelope is `../provider-stream.ts`.
 *
 * Its accumulator takes no `longCacheWrites`: this wire reports no cache writes.
 */
import OpenAI from "openai";
import type { ProviderConfig } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { providerClientOptions } from "../provider-http-error.js";
import { streamProvider } from "../provider-stream.js";
import { toOpenAIChatCompletionParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "./stream-collect.js";

export function createOpenAICompatibleAdapter(config: ProviderConfig): ProviderAdapter {
  const client = new OpenAI(providerClientOptions(config));
  const providerId = config.id;

  return {
    stream(request, model, call) {
      const acc = createStreamAccumulator(model.id, providerId);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        open: () =>
          client.chat.completions.create(
            { ...toOpenAIChatCompletionParams(request, model, call), stream: true },
            { signal: request.signal },
          ),
        events: (chunk) => eventsFromOpenAIChunk(chunk, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
