/**
 * What the chat composer's Stop acts on: the thread's active work, read from
 * the turns it owns.
 *
 * Work is active while a reply streams, and also while a placeholder with no
 * stream of its own is pending: a compaction divider, or a handoff brief being
 * written (a pending seed, which holds the chat without a run lease or
 * phase). The composer offers Stop for all of them, and a send meanwhile
 * queues like any send during a run. The placeholder is read from turns rather
 * than the lease because the turn settles with the row the writer sees; the
 * snapshot's status can trail it.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { isHandoffSeed } from "./derivation/handoff-seed";

export type ComposerRun =
  /** The latest assistant reply is streaming; the run controller stops it. */
  | { kind: "reply" }
  /** A compaction or a handoff brief is in progress; cancel targets its turn. */
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
    if ((turn.role === "compaction" || isHandoffSeed(turn)) && inProgress(turn))
      return { kind: "placeholder", turn };
  }
  return null;
}
