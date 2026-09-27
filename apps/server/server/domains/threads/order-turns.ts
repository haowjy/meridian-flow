/** Thread transcript ordering uses the position assigned under the thread lock. */
import type { Turn } from "@meridian/contracts/threads";

export function orderTurnsByPosition(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((a, b) => a.position - b.position);
}
