/**
 * Gateway port: the provider-neutral interface (stream/listModels)
 * the rest of the runtime depends on instead of any concrete provider.
 *
 * This is the top-level port that the orchestrator and turn runner consume.
 * They call `gateway.stream(request)` to get an AsyncIterable<StreamEvent>.
 * They never know which provider is behind the call.
 *
 * Why a port: adapters are DI/config-driven (see create-gateway.ts). The
 * runtime composition root wires the right adapter based on GatewayConfig,
 * and route handlers never import concrete adapter factories.
 */
import type { GenerateRequest, ModelInfo, StreamEvent } from "../domain/index.js";

export interface Gateway {
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  listModels(): ModelInfo[];
  getDefaultModel(): string | undefined;
}
