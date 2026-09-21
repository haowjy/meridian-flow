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
 *    a. Without fallback: resolve the primary route, stream with retry.
 *    b. With fallback: iterate the provider list; for each, streamForProvider()
 *       runs streamWithRetry(). On a retryable error before committed output,
 *       move to the next provider. After committed output, propagate.
 * 4. Per-attempt timeout policy is resolved per model through
 *    resolveModelAttemptTimeouts (model override, then gateway config, then the
 *    process default) and handed to streamWithRetry.
 * 5. gateway.generate() is the convenience wrapper: consumeStream(gateway.stream()).
 */
import { createAnthropicAdapter } from "./adapters/anthropic/adapter.js";
import { createOpenAIResponsesAdapter } from "./adapters/openai/adapter.js";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible/adapter.js";
import { createOpenRouterAdapter } from "./adapters/openrouter/adapter.js";
import { settleOpenRouterCancelledResult } from "./adapters/openrouter/cancel-settlement.js";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  resolveOpenRouterApiKey,
} from "./adapters/openrouter/config.js";
import {
  type ModelAttemptTimeoutOverrides,
  resolveModelAttemptTimeouts,
  streamWithRetry,
} from "./attempt-stream.js";
import { consumeStream } from "./consume-stream.js";
import { settleGenericCancelledResult } from "./domain/cancel-settlement.js";
import type {
  CancelledResultSettlement,
  CancelledResultSettlementInput,
  GatewayConfig,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import {
  buildProviderRegistry,
  fallbackProviderIds,
  type ProviderRegistry,
  type ResolvedRoute,
  resolveRoute,
  resolveRouteForProvider,
} from "./routing.js";
import { isCommittedOutputEvent } from "./stream-events.js";

/** Maps a ProviderConfig.adapter string to its concrete ProviderAdapter factory. */
function createAdapter(config: GatewayConfig["providers"][number]): ProviderAdapter {
  switch (config.adapter) {
    case "openai-compatible":
      return createOpenAICompatibleAdapter(config);
    case "openrouter":
      return createOpenRouterAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "openai":
      return createOpenAIResponsesAdapter(config);
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

function resolveSettlementProvider(
  registry: ProviderRegistry,
  input: CancelledResultSettlementInput,
  defaultModel: string | undefined,
): ProviderConfig | undefined {
  if (input.result) {
    return registry.providers.find((provider) => provider.id === input.result?.provider);
  }

  try {
    return resolveRoute(registry, { model: input.model, messages: [] }, defaultModel)
      .providerConfig;
  } catch {
    return undefined;
  }
}

async function settleCancelledResultForGateway(
  registry: ProviderRegistry,
  input: CancelledResultSettlementInput,
  defaultModel: string | undefined,
): Promise<CancelledResultSettlement | null> {
  const providerConfig = resolveSettlementProvider(registry, input, defaultModel);
  if (providerConfig?.adapter === "openrouter") {
    const apiKey = resolveOpenRouterApiKey(providerConfig.auth);
    return settleOpenRouterCancelledResult({
      ...input,
      model: input.result?.model ?? input.model,
      provider: providerConfig.id,
      baseUrl: providerConfig.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  return settleGenericCancelledResult(input);
}

/**
 * Stream for a specific provider, resolving the model from the registry.
 * Handles error cases: no model specified, model not served by this provider,
 * no adapter registered.
 */
async function* streamForProvider(
  registry: ProviderRegistry,
  providerId: string,
  request: GenerateRequest,
  defaultModel: string | undefined,
  retry: GatewayConfig["retry"],
  timeoutOverrides: ModelAttemptTimeoutOverrides,
): AsyncGenerator<StreamEvent> {
  const modelId = request.model ?? defaultModel;
  if (!modelId) {
    yield {
      type: "error",
      code: "invalid_request",
      message: "No model specified",
      retryable: false,
    };
    return;
  }

  let route: ResolvedRoute;
  try {
    route = resolveRouteForProvider(registry, providerId, modelId);
  } catch (err) {
    yield {
      type: "error",
      code: "invalid_request",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
    return;
  }

  yield* streamWithRetry(
    route.adapter,
    request,
    route.model,
    retry,
    resolveModelAttemptTimeouts(route.model, timeoutOverrides),
  );
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
      const fallback = config.fallback;
      const timeoutOverrides: ModelAttemptTimeoutOverrides = {
        attemptStallMs: config.attemptStallMs,
        attemptCeilingMs: config.attemptCeilingMs,
      };

      // ── No fallback: single-provider path ──
      // Resolve the primary route and stream with retry. Routing errors
      // (unknown model, missing adapter) are surfaced as non-retryable
      // invalid_request errors.
      if (!fallback?.enabled) {
        try {
          const route = resolveRoute(registry, request, config.defaultModel);
          yield* streamWithRetry(
            route.adapter,
            request,
            route.model,
            retry,
            resolveModelAttemptTimeouts(route.model, timeoutOverrides),
          );
        } catch (err) {
          yield {
            type: "error",
            code: "invalid_request",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          };
        }
        return;
      }

      // ── Fallback: multi-provider path ──
      // Build the ordered fallback chain (primary first, then config.order or
      // registry order). For each provider in the chain:
      //   - Stream events. If committed output was emitted before the error,
      //     propagate the error immediately (no fallback).
      //   - On a retryable error with no committed output: move to the next
      //     provider.
      //   - On a non-retryable error: yield and return.
      // If all providers fail, yield the last error.
      const providerIds = fallbackProviderIds(
        registry,
        request,
        config.defaultModel,
        fallback.order,
      );

      let lastError: StreamEvent | undefined;
      for (const providerId of providerIds) {
        let failed = false;
        let emittedCommittedOutput = false;
        for await (const event of streamForProvider(
          registry,
          providerId,
          request,
          config.defaultModel,
          retry,
          timeoutOverrides,
        )) {
          if (event.type === "error") {
            lastError = event;
            if (emittedCommittedOutput) {
              yield event;
              return;
            }
            failed = event.retryable;
            break;
          }
          yield event;
          emittedCommittedOutput ||= isCommittedOutputEvent(event);
          if (event.type === "end") return;
        }
        if (!failed) return;
      }

      if (lastError) yield lastError;
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return consumeStream(gateway.stream(request));
    },

    async settleCancelledResult(
      input: CancelledResultSettlementInput,
    ): Promise<CancelledResultSettlement | null> {
      return settleCancelledResultForGateway(registry, input, config.defaultModel);
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
