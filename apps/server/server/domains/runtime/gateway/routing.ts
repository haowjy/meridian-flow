/**
 * Provider routing: resolves a GenerateRequest to its provider adapter, model,
 * and provider config from the registry. Owns request->provider selection;
 * depends inward on domain types and the provider-adapter port.
 */
import type { GenerateRequest, ModelInfo, ProviderConfig, TraceSpan } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";

/** The fully resolved output of resolveRoute() — everything needed to stream. */
export interface ResolvedRoute {
  adapter: ProviderAdapter;
  model: ModelInfo;
  providerConfig: ProviderConfig;
}

/**
 * Provider registry — the lookup data structure that maps model IDs to
 * adapters. Built once at gateway construction time from the GatewayConfig
 * providers list. Models are indexed O(1) by ID; providers by ID.
 */
export interface ProviderRegistry {
  providers: ProviderConfig[];
  adapters: Map<string, ProviderAdapter>;
  modelsById: Map<string, { model: ModelInfo; providerId: string }>;
}

export interface ProviderRegistryBuildOptions {
  onWarning?: (span: TraceSpan) => void;
}

/**
 * Build the registry from ProviderConfig[] and the adapter map.
 * For each model in each provider config, stamps the model's `provider` field
 * with the provider's config ID (the config-level identity, not whatever the
 * model advertises) so resolveRoute has a single consistent provider ID.
 */
export function buildProviderRegistry(
  configs: ProviderConfig[],
  adapters: Map<string, ProviderAdapter>,
  options: ProviderRegistryBuildOptions = {},
): ProviderRegistry {
  const modelsById = new Map<string, { model: ModelInfo; providerId: string }>();
  for (const config of configs) {
    for (const model of config.models) {
      const existing = modelsById.get(model.id);
      if (existing) {
        options.onWarning?.({
          name: "gateway.model_collision_skipped",
          attributes: {
            modelId: model.id,
            keptProviderId: existing.providerId,
            skippedProviderId: config.id,
          },
        });
        continue;
      }
      const withProvider: ModelInfo = { ...model, provider: config.id };
      modelsById.set(model.id, { model: withProvider, providerId: config.id });
    }
  }
  return { providers: configs, adapters, modelsById };
}

/**
 * Resolve the adapter and model for a request.
 *
 * Resolution order:
 * 1. Use `request.model` if present, else `defaultModel`.
 * 2. Look up the model in modelsById to find its provider.
 * 3. Look up the adapter for the resolved provider ID.
 *
 * Throws on: missing model, missing adapter,
 * missing provider config. These are caught by the gateway.stream() caller
 * and surfaced as non-retryable invalid_request errors.
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

  const entry = registry.modelsById.get(modelId);
  if (!entry) {
    throw new Error(`Unknown model: ${modelId}`);
  }

  const providerId = entry.providerId;
  const adapter = registry.adapters.get(providerId);
  if (!adapter) {
    throw new Error(`No adapter registered for provider: ${providerId}`);
  }

  const providerConfig = registry.providers.find((p) => p.id === providerId);
  if (!providerConfig) {
    throw new Error(`Provider config not found: ${providerId}`);
  }

  return { adapter, model: entry.model, providerConfig };
}
