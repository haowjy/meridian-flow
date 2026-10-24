/** Shared client projection of time remaining before scheduled deletion. */
import { DAY_MS, DELETION_RETENTION_DAYS } from "@meridian/contracts/retention";

/** Whole days until a scheduled purge, counting a started day as a day. */
export function daysUntilPurge(purgeAt: string | Date, now: number): number {
  const days = Math.ceil((new Date(purgeAt).getTime() - now) / DAY_MS);
  return Math.min(DELETION_RETENTION_DAYS, Math.max(0, days));
}
