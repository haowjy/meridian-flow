// Lifecycle values used for response commit transitions and observability.
import type { JournalCommitKind } from "../ports/update-journal.js";
import type { ResponseCommitterPhase, ResponseLifecycleClosedState } from "./types.js";

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

export function lifecycleToCommitterPhase(lifecycle: MutationLifecycle): ResponseCommitterPhase {
  if (lifecycle.phase === "closed") return "closed";
  return lifecycle.phase;
}
