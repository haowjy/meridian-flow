/** Pure restore policy shared by every Work repository adapter. */
import { type Work, workPurgeAt } from "@meridian/contracts/works";
import { WorkRestoreExpiredError } from "../ports/work-repository.js";

export type WorkRestoreDecision = "restore" | "unchanged";

export function decideWorkRestore(work: Work, now: Date): WorkRestoreDecision {
  if (!work.deletedAt) return "unchanged";
  if (workPurgeAt(work.deletedAt).getTime() <= now.getTime()) {
    throw new WorkRestoreExpiredError();
  }
  return "restore";
}
