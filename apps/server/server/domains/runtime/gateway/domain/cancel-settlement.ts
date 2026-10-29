/**
 * Gateway-level cancelled-call settlement: the orchestrator sees a
 * provider-neutral result/persist contract.
 */

import { hasBillableTokenUsage, readMeteringStatus } from "./metering.js";
import type { GenerateResult } from "./types.js";

export interface CancelledResultSettlement {
  result: GenerateResult;
  persist: boolean;
}

/** Whether a provider-neutral cancelled model call has billable usage worth persisting. */
function shouldPersistCancelledResult(result: GenerateResult): boolean {
  return (
    hasBillableTokenUsage(result.usage) ||
    readMeteringStatus(result.providerData) === "missing_usage"
  );
}

/** The result to persist for an interrupted call, or null when there is nothing billable. */
export function settleCancelledResult(result?: GenerateResult): CancelledResultSettlement | null {
  return result && shouldPersistCancelledResult(result) ? { result, persist: true } : null;
}
