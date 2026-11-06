/**
 * Gateway factory: assembles the provider registry from config, wires the
 * anthropic/openai/openai-compatible adapters, and returns a Gateway that routes
 * each request to its provider. The gateway's composition root; the per-attempt
 * retry/deadline driver lives in attempt-stream.ts.
 *
 * ── how it works ──
 * 1. createAdapter() maps each ProviderConfig.adapter to its factory.
 * 2. buildProviderRegistry() indexes models by ID so resolveRoute() can look up
 *    adapter + model in O(1).
 * 3. gateway.stream() is the main entry point:
 *    Resolve the model's route and stream it with retry. Routing errors are
 *    non-retryable invalid_request errors; there is no cross-provider fallback.
 * 4. Per-attempt timeout policy is resolved through
 *    resolveAttemptTimeouts (gateway config, then the process default) and handed to streamWithRetry.
 * 5. gateway.generate() is the convenience wrapper: consumeStream(gateway.stream()).
 */
import { createAnthropicAdapter } from "./adapters/anthropic/adapter.js";
import { assertCacheTtlsOnWire as assertAnthropicCacheTtlsOnWire } from "./adapters/anthropic/request-map.js";
import { createOpenAIResponsesAdapter } from "./adapters/openai/adapter.js";
import { assertCacheTtlsOnWire as assertOpenAICacheTtlsOnWire } from "./adapters/openai/request-map.js";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible/adapter.js";
import {
  type ModelAttemptTimeoutOverrides,
  resolveAttemptTimeouts,
  streamWithRetry,
} from "./attempt-stream.js";
import { consumeStream } from "./consume-stream.js";
import type {
  GatewayConfig,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import { buildProviderRegistry, resolveRoute } from "./routing.js";

/** Maps a ProviderConfig.adapter to its concrete ProviderAdapter factory. */
function createAdapter(config: GatewayConfig["providers"][number]): ProviderAdapter {
  switch (config.adapter) {
    case "openai-compatible":
      return createOpenAICompatibleAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      return createOpenAIResponsesAdapter(config);
  }
}

/**
 * Reject a provider whose models ask for cache lifetimes its wire cannot express.
 * Separate from adapter construction so the env factory can check every registry
 * row, including providers whose key is not set in this deployment.
 */
export function assertModelsOnWire(config: Pick<ProviderConfig, "adapter" | "models">): void {
  for (const model of config.models) {
    if (config.adapter === "anthropic") assertAnthropicCacheTtlsOnWire(model);
    else if (config.adapter === "openai") assertOpenAICacheTtlsOnWire(model);
  }
}

export function createGateway(config: GatewayConfig): Gateway {
  for (const provider of config.providers) assertModelsOnWire(provider);
  const registry = buildProviderRegistry(
    config.providers.map((provider) => ({ config: provider, adapter: createAdapter(provider) })),
    config.onWarning,
  );

  const gateway: Gateway = {
    async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
      const retry = config.retry;
      const timeoutOverrides: ModelAttemptTimeoutOverrides = {
        attemptStallMs: config.attemptStallMs,
        attemptCeilingMs: config.attemptCeilingMs,
      };

      // Routing errors (unknown model, missing adapter) are surfaced as
      // non-retryable invalid_request errors.
      try {
        const route = resolveRoute(registry, request, config.defaultModel);
        yield* streamWithRetry(
          route.adapter,
          request,
          route.model,
          retry,
          resolveAttemptTimeouts(timeoutOverrides),
        );
      } catch (err) {
        yield {
          type: "error",
          code: "invalid_request",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
      }
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      let result: GenerateResult;
      try {
        result = await consumeStream(gateway.stream(request));
      } catch (error) {
        // A stop before the call began leaves no terminal event; that is the stop, not a stream bug.
        request.signal?.throwIfAborted();
        throw error;
      }
      // A stopped call ends with a partial or empty result, which is not a completed generation.
      request.signal?.throwIfAborted();
      return result;
    },

    listModels(): ModelInfo[] {
      return [...registry.values()].map((e) => e.model);
    },

    getDefaultModel(): string | undefined {
      return config.defaultModel;
    },
  };

  return gateway;
}
