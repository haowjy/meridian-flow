/**
 * Gateway-level cancelled-call settlement helpers. Provider adapters add any
 * special reconciliation behind the Gateway port; the orchestrator only sees
 * this provider-neutral result/persist contract.
 */

import { hasBillableTokenUsage, readMeteringStatus } from "./metering.js";
import type { GenerateResult } from "./types.js";

const RECONCILE_TIMEOUT_MS = 5_000;

export interface CancelledResultSettlementInput {
  /** Partial result produced by adapter drain, when the provider returned one. */
  result?: GenerateResult;
  /** Resolved model used for the interrupted call. */
  model: string;
  /** Provider request/generation identifier, when the gateway knows one generically. */
  providerRequestId?: string;
  /** Optional caller-provided reconciliation bound; gateways create their own when omitted. */
  signal?: AbortSignal;
}

export interface CancelledResultSettlement {
  result: GenerateResult;
  persist: boolean;
}

/** Fresh bounded signal for post-cancel provider lookups — never the user-cancel signal. */
export function createReconcileSignal(timeoutMs = RECONCILE_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

/** Whether a provider-neutral cancelled model call has billable usage worth persisting. */
export function shouldPersistCancelledResult(result: GenerateResult): boolean {
  return (
    hasBillableTokenUsage(result.usage) ||
    readMeteringStatus(result.providerData) === "missing_usage"
  );
}

export function buildReconciliationStub(input: {
  model: string;
  provider: string;
  providerRequestId?: string;
  providerData?: unknown;
}): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: input.model,
    provider: input.provider,
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.providerData !== undefined ? { providerData: input.providerData } : {}),
  };
}

export function settleGenericCancelledResult(
  input: CancelledResultSettlementInput,
): CancelledResultSettlement | null {
  if (!input.result || !shouldPersistCancelledResult(input.result)) return null;
  return { result: input.result, persist: true };
}
