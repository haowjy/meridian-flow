/**
 * Gateway-level cancelled-call settlement: the orchestrator sees a
 * provider-neutral persist predicate.
 */

import { hasBillableTokenUsage, readMeteringStatus } from "./metering.js";
import type { GenerateResult } from "./types.js";

/** Whether a provider-neutral cancelled model call has billable usage worth persisting. */
export function shouldPersistCancelledResult(result: GenerateResult): boolean {
  return (
    hasBillableTokenUsage(result.usage) ||
    readMeteringStatus(result.providerData) === "missing_usage"
  );
}
