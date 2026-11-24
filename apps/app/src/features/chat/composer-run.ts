import type { Turn } from "@meridian/contracts/protocol";
import { isHandoffSeed } from "@meridian/contracts/threads";

export type ComposerRun = { kind: "reply" } | { kind: "placeholder"; turn: Turn } | null;

function inProgress(turn: Turn): boolean {
  return turn.status === "pending" || turn.status === "streaming";
}

export function composerRun(turns: readonly Turn[]): ComposerRun {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    if (turn.role === "assistant") {
      if (turn.status === "streaming") return { kind: "reply" };
      if (!inProgress(turn)) break;
    }
    if (isHandoffSeed(turn) && inProgress(turn)) return { kind: "placeholder", turn };
  }
  return null;
}
