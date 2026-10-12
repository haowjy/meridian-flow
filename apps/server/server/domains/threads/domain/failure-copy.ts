/** Canonical writer-facing copy for failed runtime turns. */
import type { Turn } from "@meridian/contracts/threads";

export const replyFailedCopy = "This response failed.";
export const handoffBriefFailedCopy = "This handoff brief couldn't be generated. Try again.";
export const compactionFailedCopy = "This conversation couldn't be compacted. Try again.";

/** Select writer-facing failure copy from the failed turn's semantic role. */
export function turnFailedCopy(turn: Pick<Turn, "role">): string {
  switch (turn.role) {
    case "assistant":
      return replyFailedCopy;
    case "system":
      return handoffBriefFailedCopy;
    case "compaction":
      return compactionFailedCopy;
    case "user":
      throw new Error(`Turn role ${turn.role} cannot own runtime failure copy`);
    default: {
      const exhaustiveRole: never = turn.role;
      return exhaustiveRole;
    }
  }
}
