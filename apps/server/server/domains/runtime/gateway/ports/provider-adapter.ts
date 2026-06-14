// @ts-nocheck
/**
 * Provider-adapter port: the one streaming primitive each provider adapter
 * (anthropic/openai/openai-compatible) implements.
 *
 * The gateway drives this and reduces the stream through consumeStream and
 * the retry/fallback machinery. Each adapter maps one provider's SDK events
 * to canonical StreamEvents.
 *
 * `providerId` is a stable string matching ProviderConfig.id, used by the
 * registry to route requests.
 *
 * Why one port: every provider has a different SDK contract, but the
 * Meridian-gateway edge is uniform. Adding a new provider means implementing
 * this one interface and registering it in createAdapter.
 */
import type { GenerateRequest, ModelInfo, StreamEvent } from "../domain/index.js";

/** Internal — adapters implement one streaming primitive. */
export interface ProviderAdapter {
  readonly providerId: string;
  stream(request: GenerateRequest, model: ModelInfo): AsyncIterable<StreamEvent>;
}
