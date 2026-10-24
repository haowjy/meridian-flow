/** Pure restore policy shared by every Work repository adapter. */
import { deletionPurgeAt, type Work } from "@meridian/contracts/works";
import { WorkRestoreExpiredError } from "../ports/work-repository.js";

export type WorkRestoreDecision = "restore" | "unchanged";

export function decideWorkRestore(work: Work, now: Date): WorkRestoreDecision {
  if (!work.deletedAt) return "unchanged";
  if (deletionPurgeAt(work.deletedAt).getTime() <= now.getTime()) {
    throw new WorkRestoreExpiredError();
  }
  return "restore";
}
