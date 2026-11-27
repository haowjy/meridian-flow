import { DAY_MS, DELETION_RETENTION_DAYS } from "@meridian/contracts/retention";

export function daysUntilPurge(purgeAt: string | Date, now: number): number {
  const days = Math.ceil((new Date(purgeAt).getTime() - now) / DAY_MS);
  return Math.min(DELETION_RETENTION_DAYS, Math.max(0, days));
}
