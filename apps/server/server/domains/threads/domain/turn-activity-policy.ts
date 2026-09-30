/** Canonical authorship policy for turn-driven thread, Work, and project activity. */
import type { TurnOrigin } from "@meridian/contracts/threads";

export function turnCountsAsActivity(origin: TurnOrigin): boolean {
  switch (origin) {
    case "writer":
    case "assistant":
      return true;
    case "system":
      return false;
  }
}
