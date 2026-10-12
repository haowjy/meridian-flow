/** Concealed ownership and deletion classification shared by all HTTP thread owner gates. */
import type { ThreadAvailabilityCode } from "@meridian/contracts/threads";

type OwnerRow = { userId: string; deletedAt: string | Date | null };

export function threadAvailabilityCode(
  thread: OwnerRow | null | undefined,
  project: OwnerRow | null | undefined,
  userId: string,
): ThreadAvailabilityCode | null {
  // Check both owners before deletion: foreign rows must look exactly like missing rows.
  if (!thread || !project || thread.userId !== userId || project.userId !== userId) {
    return "thread_not_found";
  }
  return thread.deletedAt || project.deletedAt ? "thread_deleted" : null;
}
