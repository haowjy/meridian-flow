/** Deleted Works remain restorable until this many days after deletion. */
export const WORK_DELETE_RETENTION_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1_000;

/** When a Work deleted at `deletedAt` is purged for good. */
export function workPurgeAt(deletedAt: string | Date): Date {
  const timestamp = deletedAt instanceof Date ? deletedAt.getTime() : Date.parse(deletedAt);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid Work deletion timestamp");
  return new Date(timestamp + WORK_DELETE_RETENTION_DAYS * DAY_MS);
}

/** Latest deletion timestamp eligible for purge at `now`. */
export function workPurgeCutoff(now: string | Date): Date {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid Work purge timestamp");
  return new Date(timestamp - WORK_DELETE_RETENTION_DAYS * DAY_MS);
}
