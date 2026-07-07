// Single algebra for mutation durability: tool → staging → journal → push → receipt.
import type { JournalCommitKind } from "../ports/update-journal.js";
import type {
  ResponseClaimDiscardedEntry,
  ResponseCommitterPhase,
  ResponseLifecycleClosedState,
  WriteSuccessPhase,
} from "./types.js";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Lifecycle position of a buffered response commit pipeline. */
export type MutationLifecycle =
  | { phase: "buffered" }
  | { phase: "journalCommitted"; journalCommitKind: JournalCommitKind }
  | { phase: "liveProjected"; journalCommitKind: JournalCommitKind }
  | {
      phase: "closed";
      closed: ResponseLifecycleClosedState;
      journalCommitKind: JournalCommitKind | null;
    };

export type ActiveMutationLifecycle = Extract<
  MutationLifecycle,
  { phase: "buffered" | "journalCommitted" | "liveProjected" }
>;

export type JournalCommittedLifecycle = Extract<
  MutationLifecycle,
  { phase: "journalCommitted" | "liveProjected" }
>;

/** Tool-level success durability for a single mutating write. */
export type WriteMutationOutcome =
  | { phase: "staged" }
  | { phase: "committed"; journalCommitKind: JournalCommitKind };

/** Aggregate mutation outcome returned from response commit. */
export type ResponseMutationAggregate = {
  lifecycle: MutationLifecycle;
  discardedClaims: readonly ResponseClaimDiscardedEntry[];
};

export function bufferedLifecycle(): ActiveMutationLifecycle {
  return { phase: "buffered" };
}

export function journalCommittedLifecycle(
  journalCommitKind: JournalCommitKind,
): JournalCommittedLifecycle {
  return { phase: "journalCommitted", journalCommitKind };
}

export function liveProjectedLifecycle(
  journalCommitKind: JournalCommitKind,
): JournalCommittedLifecycle {
  return { phase: "liveProjected", journalCommitKind };
}

export function closedLifecycle(
  closed: ResponseLifecycleClosedState,
  journalCommitKind: JournalCommitKind | null,
): Extract<MutationLifecycle, { phase: "closed" }> {
  return { phase: "closed", closed, journalCommitKind };
}

export function journalKindFromLifecycle(lifecycle: MutationLifecycle): JournalCommitKind | null {
  if (lifecycle.phase === "journalCommitted" || lifecycle.phase === "liveProjected") {
    return lifecycle.journalCommitKind;
  }
  if (lifecycle.phase === "closed") return lifecycle.journalCommitKind;
  return null;
}

export function hasCommittedJournalKind(
  lifecycle: MutationLifecycle,
): lifecycle is JournalCommittedLifecycle {
  return lifecycle.phase === "journalCommitted" || lifecycle.phase === "liveProjected";
}

export function isActiveLifecycle(
  lifecycle: MutationLifecycle,
): lifecycle is ActiveMutationLifecycle {
  return lifecycle.phase !== "closed";
}

export function lifecycleToCommitterPhase(lifecycle: MutationLifecycle): ResponseCommitterPhase {
  if (lifecycle.phase === "closed") return "closed";
  return lifecycle.phase;
}

export function stagedWriteOutcome(): WriteMutationOutcome {
  return { phase: "staged" };
}

export function committedWriteOutcome(journalCommitKind: JournalCommitKind): WriteMutationOutcome {
  return { phase: "committed", journalCommitKind };
}

export function writeOutcomeToPhase(outcome: WriteMutationOutcome): WriteSuccessPhase {
  return outcome.phase;
}

export function responseAggregateToCommitFields(aggregate: ResponseMutationAggregate): {
  discardedClaims?: readonly ResponseClaimDiscardedEntry[];
} {
  return aggregate.discardedClaims.length > 0 ? { discardedClaims: aggregate.discardedClaims } : {};
}
