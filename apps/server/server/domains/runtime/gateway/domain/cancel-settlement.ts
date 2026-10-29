/**
 * Gateway-level cancelled-call settlement: the orchestrator sees a
 * provider-neutral result/persist contract.
 */

import { hasBillableTokenUsage, readMeteringStatus } from "./metering.js";
import type { GenerateResult } from "./types.js";

export interface CancelledResultSettlementInput {
  /** Partial result produced by adapter drain, when the provider returned one. */
  result?: GenerateResult;
  /** Resolved model used for the interrupted call. */
  model: string;
}

export interface CancelledResultSettlement {
  result: GenerateResult;
  persist: boolean;
}

/** Whether a provider-neutral cancelled model call has billable usage worth persisting. */
export function shouldPersistCancelledResult(result: GenerateResult): boolean {
  return (
    hasBillableTokenUsage(result.usage) ||
    readMeteringStatus(result.providerData) === "missing_usage"
  );
}

export function settleGenericCancelledResult(
  input: CancelledResultSettlementInput,
): CancelledResultSettlement | null {
  if (!input.result || !shouldPersistCancelledResult(input.result)) return null;
  return { result: input.result, persist: true };
}
