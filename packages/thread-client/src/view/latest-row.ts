import type { Turn } from "@meridian/contracts/protocol";
import { isClosingRow } from "@meridian/contracts/threads";

export function latestRow(turns: readonly Turn[]): { turn: Turn; index: number } | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn && isClosingRow(turn)) return { turn, index };
  }
  return null;
}
