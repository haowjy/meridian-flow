/**
 * latest-row — the client twin of the server's `latestRowAt`: the newest closing row of a sequence
 * (`isClosingRow`: a conversation turn or a compaction). Everything before it has been moved past,
 * so a failure there has ended and its Retry is gone. `viewTranscript` (through `chatMovedPast`) and
 * `chatCards` both read it, over the normalized sequence, so neither depends on the other.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { isClosingRow } from "@meridian/contracts/threads";

/** The newest closing row and its place, or null when the sequence has none. */
export function latestRow(turns: readonly Turn[]): { turn: Turn; index: number } | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn && isClosingRow(turn)) return { turn, index };
  }
  return null;
}
