import type { Turn } from "@meridian/contracts/protocol";
import { classifyTurn } from "./transcript-model";

export function placeStandIns(stored: Turn[], local: readonly Turn[]): Turn[] {
  if (!local.length) return stored;
  const placed = [...stored];
  for (const standIn of local) {
    const after = placed.findIndex((turn) => turn.id === standIn.prevTurnId);
    if (after < 0) {
      placed.push(standIn);
      continue;
    }
    let at = after + 1;
    while (
      placed[at] &&
      !local.includes(placed[at] as Turn) &&
      classifyTurn(placed[at] as Turn) === "write-mode"
    )
      at++;
    while (local.includes(placed[at] as Turn) && placed[at]?.prevTurnId === standIn.prevTurnId)
      at++;
    placed.splice(at, 0, standIn);
  }
  return placed;
}
