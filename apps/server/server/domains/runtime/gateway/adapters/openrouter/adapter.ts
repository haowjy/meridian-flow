/**
 * OpenRouter provider adapter: Chat Completions wire against OpenRouter's base URL,
 * with OpenRouter-only stream metadata and best-effort /generation enrichment.
 */

import OpenAI from "openai";
import { modelAttemptTimeoutEvent } from "../../deadline.js";
import { createReconcileSignal } from "../../domain/cancel-settlement.js";
import type {
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { mapOpenAIError } from "../openai-compatible/errors.js";
import { toOpenAIChatCompletionParams } from "../openai-compatible/request-map.js";
import { accumulatorHasPartialResult } from "../openai-compatible/stream-collect.js";
import { DEFAULT_OPENROUTER_BASE_URL, resolveOpenRouterApiKey } from "./config.js";
import { enrichOpenRouterResult } from "./enrich-result.js";
import {
  buildOpenRouterGenerateResult,
  createOpenRouterStreamAccumulator,
  eventsFromOpenRouterChunk,
} from "./stream-collect.js";

function enrichSignal(request: GenerateRequest): AbortSignal | undefined {
  return request.signal?.aborted ? createReconcileSignal() : request.signal;
}

async function enrichResult(
  result: Awaited<ReturnType<typeof buildOpenRouterGenerateResult>>,
  apiKey: string | undefined,
  baseUrl: string,
  request: GenerateRequest,
) {
  try {
    return await enrichOpenRouterResult(result, apiKey, baseUrl, enrichSignal(request));
  } catch {
    return result;
  }
}
function openRouterHeaders(config: ProviderConfig): Record<string, string> {
  return {
    ...config.auth?.headers,
    "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://meridian.flow",
    "X-Title": process.env.OPENROUTER_APP_NAME ?? "Meridian Flow",
  };
}

export function createOpenRouterAdapter(config: ProviderConfig): ProviderAdapter {
  const apiKey = resolveOpenRouterApiKey(config.auth);
  const baseUrl = config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const client = new OpenAI({
    apiKey: apiKey ?? "not-needed",
    baseURL: baseUrl,
    defaultHeaders: openRouterHeaders(config),
  });
  const providerId = config.id;

  return {
    providerId,
    async *stream(request: GenerateRequest, model: ModelInfo): AsyncIterable<StreamEvent> {
      const acc = createOpenRouterStreamAccumulator(model.id, providerId);
      yield { type: "start", model: model.id, provider: providerId };

      try {
        const params = toOpenAIChatCompletionParams(request, model.id);
        const stream = await client.chat.completions.create(
          { ...params, stream: true },
          { signal: request.signal },
        );

        for await (const chunk of stream) {
          yield* eventsFromOpenRouterChunk(chunk, acc);
        }

        const result = buildOpenRouterGenerateResult(acc);
        const enriched = await enrichResult(result, apiKey, baseUrl, request);
        yield { type: "end", result: enriched };
      } catch (err) {
        if (request.signal?.aborted) {
          const timeout = modelAttemptTimeoutEvent(request.signal);
          if (timeout) {
            yield timeout;
            return;
          }
          if (accumulatorHasPartialResult(acc) || acc.generationId) {
            const partial = buildOpenRouterGenerateResult(acc);
            const enriched = await enrichResult(partial, apiKey, baseUrl, request);
            yield { type: "end", result: enriched };
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
