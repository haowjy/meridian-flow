/**
 * What the chat composer's Stop acts on, read from the turns the chat holds.
 *
 * A reply is in progress while the latest assistant turn streams; the chat Stop handles it,
 * and handles everything else the run-state record says is busy (a compaction, the gap between
 * replies, a usage-blocked wait). Only a handoff brief being written is read here: a pending
 * seed holds the chat with no lease or run, so the record has nothing to say about it, and its
 * Stop is the brief's own.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { isHandoffSeed } from "@meridian/contracts/threads";

export type ComposerRun =
  /** The latest assistant reply is streaming. */
  | { kind: "reply" }
  /** A handoff brief is being written; cancel targets its turn. */
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
    if (isHandoffSeed(turn) && inProgress(turn)) return { kind: "placeholder", turn };
  }
  return null;
}
