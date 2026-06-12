// @ts-nocheck
/**
 * OpenAI Responses provider adapter: implements the provider-adapter port over
 * the OpenAI Responses API, translating to/from canonical gateway types. Owns
 * the OpenAI-specific streaming wiring; depends on its request-map/stream-collect/errors siblings.
 *
 * Streaming lifecycle:
 * 1. Create accumulator → yield `start` event
 * 2. Map canonical request to Responses params (request-map)
 * 3. Call `client.responses.create()` with `stream: true`
 * 4. For each SSE event, yield canonical StreamEvents (stream-collect)
 * 5. Build final GenerateResult from accumulator → yield `end` event
 * 6. On error, map to canonical error event (errors module)
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
import { mapOpenAIResponsesError } from "./errors.js";
import { toOpenAIResponsesParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromResponseStreamEvent,
} from "./stream-collect.js";

function resolveApiKey(auth: ProviderConfig["auth"]): string | undefined {
  if (!auth?.apiKey) return undefined;
  return typeof auth.apiKey === "function" ? auth.apiKey() : auth.apiKey;
}

export function createOpenAIResponsesAdapter(config: ProviderConfig): ProviderAdapter {
  const apiKey = resolveApiKey(config.auth);
  const client = new OpenAI({
    apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
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
        const params = toOpenAIResponsesParams(request, model.id, providerId);
        const stream = await client.responses.create(params, { signal: request.signal });

        for await (const event of stream) {
          yield* eventsFromResponseStreamEvent(event, acc);
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
        const mapped = mapOpenAIResponsesError(err);
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
