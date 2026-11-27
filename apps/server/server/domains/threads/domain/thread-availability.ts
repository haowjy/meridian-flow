import type { ThreadAvailabilityCode } from "@meridian/contracts/threads";

type OwnerRow = { userId: string; deletedAt: string | Date | null };

export function threadAvailabilityCode(
  thread: OwnerRow | null | undefined,
  project: OwnerRow | null | undefined,
  userId: string,
): ThreadAvailabilityCode | null {
  if (!thread || !project || thread.userId !== userId || project.userId !== userId) {
    return "thread_not_found";
  }
  return thread.deletedAt || project.deletedAt ? "thread_deleted" : null;
}
