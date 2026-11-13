/**
 * Provider routing: resolves a GenerateRequest to its provider adapter and
 * model. Owns request->provider selection; depends inward on domain types and
 * the provider-adapter port.
 */
import type { GenerateRequest, ModelInfo, ProviderConfig, TraceSpan } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";

/** The fully resolved output of resolveRoute() — everything needed to stream. */
export interface ResolvedRoute {
  adapter: ProviderAdapter;
  model: ModelInfo;
}

/** Model ID -> route, built once at gateway construction from the providers list. */
export type ProviderRegistry = Map<string, ResolvedRoute>;

/**
 * Index every provider's models by ID. The first provider to declare a model
 * keeps it; later duplicates are skipped with a warning.
 */
export function buildProviderRegistry(
  providers: Array<{ config: ProviderConfig; adapter: ProviderAdapter }>,
  onWarning?: (span: TraceSpan) => void,
): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  for (const { config, adapter } of providers) {
    for (const model of config.models) {
      const existing = registry.get(model.id);
      if (existing) {
        onWarning?.({
          name: "gateway.model_collision_skipped",
          attributes: {
            modelId: model.id,
            keptProviderId: existing.model.provider,
            skippedProviderId: config.id,
          },
        });
        continue;
      }
      registry.set(model.id, { adapter, model: { ...model, wire: config.adapter } });
    }
  }
  return registry;
}

/**
 * Resolve the adapter and model for a request: `request.model` if present, else
 * `defaultModel`. Throws on a missing or unknown model; the gateway.stream()
 * caller surfaces it as a non-retryable invalid_request error.
 */
export function resolveRoute(
  registry: ProviderRegistry,
  request: GenerateRequest,
  defaultModel?: string,
): ResolvedRoute {
  const modelId = request.model ?? defaultModel;
  if (!modelId) {
    throw new Error("No model specified and no defaultModel configured");
  }
  const route = registry.get(modelId);
  if (!route) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  return route;
}
