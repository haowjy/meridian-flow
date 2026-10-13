/**
 * Placement of Retry stand-ins: turns the writer sees before the server has
 * them (a handoff brief's new seed, a failed reply's new reply). Each carries
 * the client-minted id the server will use, so the stored turn replaces it by
 * id once it arrives.
 */
import type { Turn } from "@meridian/contracts/protocol";

/**
 * The stored turns with each stand-in placed after the turn it followed when
 * the writer pressed Retry. Turns the server adds later land below it, so a
 * stand-in never drifts to the bottom of the chat or outranks a newer turn.
 * A stand-in whose previous turn is not in view goes at the end.
 */
export function placeStandIns(stored: Turn[], local: readonly Turn[]): Turn[] {
  if (!local.length) return stored;
  const placed = [...stored];
  for (const standIn of local) {
    const after = placed.findIndex((turn) => turn.id === standIn.prevTurnId);
    if (after < 0) {
      placed.push(standIn);
      continue;
    }
    // Earlier stand-ins that followed the same turn stay ahead of this one.
    let at = after + 1;
    while (local.includes(placed[at] as Turn) && placed[at]?.prevTurnId === standIn.prevTurnId)
      at++;
    placed.splice(at, 0, standIn);
  }
  return placed;
}
