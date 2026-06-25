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
import type {
  CancelledResultSettlement,
  CancelledResultSettlementInput,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  StreamEvent,
} from "../domain/index.js";

export interface Gateway {
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /**
   * Reconcile an interrupted/cancelled call for billing correctness. The gateway
   * resolves provider-specific behavior (for example provider metering lookups)
   * and returns the result to persist, or null when there is nothing to settle.
   */
  settleCancelledResult?(
    input: CancelledResultSettlementInput,
  ): Promise<CancelledResultSettlement | null>;
  listModels?(): ModelInfo[];
  getDefaultModel(): string | undefined;
}
