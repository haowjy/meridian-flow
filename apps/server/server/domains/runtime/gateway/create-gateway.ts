/**
 * Gateway factory: assembles the provider registry from config, wires the
 * anthropic/openai/openai-compatible adapters, and returns a Gateway that routes
 * each request to its provider. The gateway's composition root; the per-attempt
 * retry/deadline driver lives in attempt-stream.ts.
 *
 * ── how it works ──
 * 1. createAdapter() maps each ProviderConfig.adapter string to its factory.
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
import { createOpenAIResponsesAdapter } from "./adapters/openai/adapter.js";
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
  StreamEvent,
} from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import { buildProviderRegistry, resolveRoute } from "./routing.js";

/** Maps a ProviderConfig.adapter string to its concrete ProviderAdapter factory. */
function createAdapter(config: GatewayConfig["providers"][number]): ProviderAdapter {
  switch (config.adapter) {
    case "openai-compatible":
      return createOpenAICompatibleAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      return createOpenAIResponsesAdapter(config);
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

export function createGateway(config: GatewayConfig): Gateway {
  const adapters = new Map<string, ProviderAdapter>();
  for (const provider of config.providers) {
    adapters.set(provider.id, createAdapter(provider));
  }
  const registry = buildProviderRegistry(config.providers, adapters, {
    onWarning: config.onWarning,
  });

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
      return consumeStream(gateway.stream(request));
    },

    listModels(): ModelInfo[] {
      return [...registry.modelsById.values()].map((e) => e.model);
    },

    getDefaultModel(): string | undefined {
      return config.defaultModel;
    },
  };

  return gateway;
}
