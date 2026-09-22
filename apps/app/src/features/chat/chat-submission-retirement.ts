/**
 * Retirement policy for the durable chat-submission journal.
 *
 * A displayed submission may be deleted only when its outcome is resolved:
 *
 * - `accepted` — the server admitted it and the controller bridged the local
 *   row via `acknowledgeUserTurn` (an epoch mismatch returns `ambiguous`
 *   instead, so `accepted` always means the bridge ran).
 * - `rejected` — the endpoint proved a refusal (a structured error or 4xx).
 *
 * `ambiguous` and `not-seen` keep the witness: the write may still land, or the
 * server never saw it and recovery must replay the stored fingerprint. Writer
 * abandonment (Start over) also retires through `retire`.
 */
import type { ComposerSubmitOutcome } from "@/components/app/composer";

export function shouldRetireSubmission(outcome: ComposerSubmitOutcome): boolean {
  return outcome.kind === "accepted" || outcome.kind === "rejected";
}
