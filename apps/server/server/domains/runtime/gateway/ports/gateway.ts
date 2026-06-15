/**
 * Gateway port: the provider-neutral interface (stream/generate/listModels)
 * the rest of the runtime depends on instead of any concrete provider.
 *
 * This is the top-level port that the orchestrator and turn runner consume.
 * They call `gateway.stream(request)` to get an AsyncIterable<StreamEvent>
 * or `gateway.generate(request)` for the convenience Promise<GenerateResult>
 * wrapper. They never know which provider is behind the call.
 *
 * Why a port: adapters are DI/config-driven (see create-gateway.ts). The
 * runtime composition root wires the right adapter based on GatewayConfig,
 * and route handlers never import concrete adapter factories.
 */
import type { GenerateRequest, GenerateResult, ModelInfo, StreamEvent } from "../domain/index.js";

export interface Gateway {
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  listModels?(): ModelInfo[];
}
