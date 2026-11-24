export const DELETION_RETENTION_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1_000;

export function deletionPurgeAt(deletedAt: string | Date): Date {
  const timestamp = deletedAt instanceof Date ? deletedAt.getTime() : Date.parse(deletedAt);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid deletion timestamp");
  return new Date(timestamp + DELETION_RETENTION_DAYS * DAY_MS);
}

export function deletionPurgeCutoff(now: string | Date): Date {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid purge timestamp");
  return new Date(timestamp - DELETION_RETENTION_DAYS * DAY_MS);
}
