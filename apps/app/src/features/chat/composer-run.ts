/**
 * What the chat composer's Stop acts on: the thread's active run, read from
 * the turns it owns.
 *
 * A run is active while its reply streams, and also while it works on a
 * run-owned placeholder that has no stream of its own: a compaction (the
 * `compacting` phase) or a handoff brief (`briefing`). The composer offers
 * Stop for all of them, and a send meanwhile queues like any send during a
 * run. The placeholder is read from turns rather than the lease phase because
 * the turn settles with the divider the writer sees; the snapshot's phase can
 * trail the run's end.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { isPlaceholderRole } from "@meridian/contracts/threads";

export type ComposerRun =
  /** The latest assistant reply is streaming; the run controller stops it. */
  | { kind: "reply" }
  /** A run-owned placeholder is in progress; cancel targets its turn, which the lease binds. */
  | { kind: "placeholder"; turn: Turn }
  | null;

function inProgress(turn: Turn): boolean {
  return turn.status === "pending" || turn.status === "streaming";
}

export function composerRun(turns: readonly Turn[]): ComposerRun {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    if (turn.role === "assistant") {
      if (turn.status === "streaming") return { kind: "reply" };
      // A settled reply is the head of the run's output; older turns are history.
      if (!inProgress(turn)) break;
    }
    if (isPlaceholderRole(turn.role) && inProgress(turn)) return { kind: "placeholder", turn };
  }
  return null;
}
