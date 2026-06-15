/**
 * OpenRouter provider adapter: reuses the openai-compatible Chat Completions wire
 * format against OpenRouter's base URL, then enriches the final result with
 * provider-reported cost (stream usage.cost or /generation fallback).
 */

import type {
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { createOpenAICompatibleAdapter } from "../openai-compatible/adapter.js";
import { enrichOpenRouterResult } from "./enrich-result.js";

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
  const inner = createOpenAICompatibleAdapter({
    ...config,
    adapter: "openai-compatible",
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    auth: {
      ...config.auth,
      apiKey,
      headers: openRouterHeaders(config),
    },
  });

  return {
    providerId: config.id,
    async *stream(request: GenerateRequest, model: ModelInfo): AsyncIterable<StreamEvent> {
      for await (const event of inner.stream(request, model)) {
        if (event.type !== "end") {
          yield event;
          continue;
        }
        const enriched = await enrichOpenRouterResult(event.result, apiKey, request.signal);
        yield { type: "end", result: enriched };
      }
    },
  };
}
