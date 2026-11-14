/** Pure restore policy shared by every Work repository adapter. */
import type { Work } from "@meridian/contracts/works";

export type WorkRestoreDecision = "restore" | "unchanged";

/** A Work still in Trash restores; only the purge sweep reads the 30-day clock. */
export function decideWorkRestore(work: Work): WorkRestoreDecision {
  return work.deletedAt ? "restore" : "unchanged";
}
