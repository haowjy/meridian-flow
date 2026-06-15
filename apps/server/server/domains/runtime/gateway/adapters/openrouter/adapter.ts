/**
 * OpenRouter provider adapter: Chat Completions wire against OpenRouter's base URL,
 * with OpenRouter-only stream metadata and best-effort /generation enrichment.
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
import { mapOpenAIError } from "../openai-compatible/errors.js";
import { toOpenAIChatCompletionParams } from "../openai-compatible/request-map.js";
import { enrichOpenRouterResult } from "./enrich-result.js";
import {
  buildOpenRouterGenerateResult,
  createOpenRouterStreamAccumulator,
  eventsFromOpenRouterChunk,
} from "./stream-collect.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function resolveApiKey(auth: ProviderConfig["auth"]): string | undefined {
  if (!auth?.apiKey) return undefined;
  return typeof auth.apiKey === "function" ? auth.apiKey() : auth.apiKey;
}

function openRouterHeaders(config: ProviderConfig): Record<string, string> {
  return {
    ...config.auth?.headers,
    "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://meridian.flow",
    "X-Title": process.env.OPENROUTER_APP_NAME ?? "Meridian Flow",
  };
}

export function createOpenRouterAdapter(config: ProviderConfig): ProviderAdapter {
  const apiKey = resolveApiKey(config.auth);
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
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
        let enriched = result;
        try {
          enriched = await enrichOpenRouterResult(result, apiKey, baseUrl, request.signal);
        } catch {
          enriched = result;
        }
        yield { type: "end", result: enriched };
      } catch (err) {
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
