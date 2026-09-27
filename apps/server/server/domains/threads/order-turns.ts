/** Thread transcript ordering uses the position assigned under the thread lock. */
import type { Turn } from "@meridian/contracts/threads";

export function orderTurnsByPosition(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
