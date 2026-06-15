/**
 * OpenAI-compatible (Chat Completions) provider adapter: implements the
 * provider-adapter port over any OpenAI-Chat-Completions-shaped endpoint
 * (deepseek, mock, self-hosted). Owns the chat-completions streaming wiring;
 * depends on its request-map/stream-collect/errors siblings.
 *
 * Streaming lifecycle:
 * 1. Create accumulator → yield `start` event
 * 2. Map canonical request to Chat Completions params (request-map)
 * 3. Call `client.chat.completions.create()` with `stream: true`
 * 4. For each chunk, yield canonical StreamEvents (stream-collect)
 * 5. Build final GenerateResult from accumulator → yield `end` event
 * 6. On error, map to canonical error event (errors module)
 *
 * Note: uses `apiKey ?? "not-needed"` as fallback because some self-hosted
 * or mock endpoints do not require authentication.
 */
import OpenAI from "openai";
import { modelAttemptTimeoutEvent } from "../../deadline.js";
import type {
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { mapOpenAIError } from "./errors.js";
import { toOpenAIChatCompletionParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "./stream-collect.js";

function resolveApiKey(auth: ProviderConfig["auth"]): string | undefined {
  if (!auth?.apiKey) return undefined;
  return typeof auth.apiKey === "function" ? auth.apiKey() : auth.apiKey;
}

export function createOpenAICompatibleAdapter(config: ProviderConfig): ProviderAdapter {
  const apiKey = resolveApiKey(config.auth) ?? "not-needed";
  const client = new OpenAI({
    apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: config.auth?.headers,
  });

  const providerId = config.id;

  return {
    providerId,
    async *stream(request: GenerateRequest, model: ModelInfo): AsyncIterable<StreamEvent> {
      // Create a fresh accumulator per stream call — each generate request
      // gets its own streaming state.
      const acc = createStreamAccumulator(model.id, providerId);
      yield { type: "start", model: model.id, provider: providerId };

      try {
        const params = toOpenAIChatCompletionParams(request, model.id);
        const stream = await client.chat.completions.create(
          { ...params, stream: true },
          { signal: request.signal },
        );

        for await (const chunk of stream) {
          yield* eventsFromOpenAIChunk(chunk, acc);
        }

        const result = buildGenerateResult(acc);
        yield { type: "end", result };
      } catch (err) {
        // Check for abort before mapping to provider errors — aborted requests
        // may produce a timeout event (from deadline.ts) or a generic abort error.
        if (request.signal?.aborted) {
          const timeout = modelAttemptTimeoutEvent(request.signal);
          if (timeout) {
            yield timeout;
            return;
          }
          yield {
            type: "error",
            code: "invalid_request",
            message: "Request aborted",
            retryable: false,
          };
          return;
        }
        const mapped = mapOpenAIError(err);
        yield {
          type: "error",
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable,
        };
      }
    },
  };
}
