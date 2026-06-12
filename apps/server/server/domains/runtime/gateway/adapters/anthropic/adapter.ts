// @ts-nocheck
/**
 * Anthropic provider adapter: implements the provider-adapter port by streaming
 * the Anthropic Messages SDK and translating to/from canonical gateway types.
 * Owns the Anthropic-specific wiring; the only place the @anthropic-ai SDK is
 * driven for streaming. Depends on request-map/stream-collect/errors siblings.
 *
 * Streaming lifecycle:
 * 1. Create accumulator → yield `start` event
 * 2. Map canonical request to Message params (request-map)
 * 3. Call `client.messages.create()` with `stream: true`
 * 4. For each SSE event, yield canonical StreamEvents (stream-collect)
 * 5. Build final GenerateResult from accumulator → yield `end` event
 * 6. On error, map to canonical error event (errors module)
 */
import Anthropic from "@anthropic-ai/sdk";
import { modelAttemptTimeoutEvent } from "../../deadline.js";
import type {
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { mapAnthropicError } from "./errors.js";
import { toAnthropicMessageParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "./stream-collect.js";

function resolveApiKey(auth: ProviderConfig["auth"]): string | undefined {
  if (!auth?.apiKey) return undefined;
  return typeof auth.apiKey === "function" ? auth.apiKey() : auth.apiKey;
}

export function createAnthropicAdapter(config: ProviderConfig): ProviderAdapter {
  const apiKey = resolveApiKey(config.auth);
  const client = new Anthropic({
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
        const params = toAnthropicMessageParams(
          request,
          model.id,
          model.maxOutputTokens,
          providerId,
        );
        const stream = await client.messages.create(params, { signal: request.signal });

        for await (const event of stream) {
          yield* eventsFromAnthropicStreamEvent(event, acc);
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
        const mapped = mapAnthropicError(err);
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
