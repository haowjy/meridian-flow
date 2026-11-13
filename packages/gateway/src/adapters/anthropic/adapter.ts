/**
 * Anthropic provider adapter: implements the provider-adapter port by streaming
 * the Anthropic Messages SDK and translating to/from canonical gateway types.
 * Owns the Anthropic-specific wiring; the only place the @anthropic-ai SDK is
 * driven for streaming. The shared stream envelope is `../provider-stream.ts`.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { type ProviderErrorPatterns, providerClientOptions } from "../provider-http-error.js";
import { streamProvider } from "../provider-stream.js";
import { toAnthropicMessageParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "./stream-collect.js";

/**
 * Anthropic also reports a filtered request as "blocked". The word must be "blocked",
 * not "block": "invalid content block" is a malformed request, not a filter.
 */
export const ANTHROPIC_ERROR_PATTERNS: Partial<ProviderErrorPatterns> = {
  contentFiltered: /content[\s\S]*(?:filter|blocked)|(?:filter|blocked)[\s\S]*content/,
};

export function createAnthropicAdapter(config: ProviderConfig): ProviderAdapter {
  const client = new Anthropic(providerClientOptions(config));
  const providerId = config.id;

  return {
    stream(request, model, call) {
      const acc = createStreamAccumulator(model.id, providerId, call.longCacheWrites);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        errorPatterns: ANTHROPIC_ERROR_PATTERNS,
        open: () =>
          client.messages.create(toAnthropicMessageParams(request, model, call), {
            signal: request.signal,
          }),
        events: (event) => eventsFromAnthropicStreamEvent(event, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
