/** Canonical writer-facing copy for failed runtime turns. */
import type { Turn } from "@meridian/contracts/threads";

export const replyFailedCopy = "This response failed.";
export const handoffBriefFailedCopy = "This handoff brief couldn't be generated. Try again.";
export const compactionFailedCopy = "This conversation couldn't be compacted. Try again.";

/** Select the ordinary failure copy for a recovered pending placeholder. */
export function placeholderFailedCopy(
  turn: Pick<Turn, "metadata"> & { role: "system" | "compaction" },
): string {
  switch (turn.role) {
    case "system":
      return handoffBriefFailedCopy;
    case "compaction":
      return compactionFailedCopy;
    default: {
      const exhaustiveRole: never = turn.role;
      return exhaustiveRole;
    }
  }
}
