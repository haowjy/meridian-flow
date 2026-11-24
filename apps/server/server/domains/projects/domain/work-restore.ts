import type { Work } from "@meridian/contracts/works";

export type WorkRestoreDecision = "restore" | "unchanged";

export function decideWorkRestore(work: Work): WorkRestoreDecision {
  return work.deletedAt ? "restore" : "unchanged";
}
