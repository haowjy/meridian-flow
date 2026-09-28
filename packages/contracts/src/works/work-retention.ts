/** How long a deleted Work (with its chats, drafts, Scratch and Uploads) stays restorable. */
export const WORK_DELETE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a Work deleted at `deletedAt` is purged for good. */
export function workPurgeAt(deletedAt: string | Date): Date {
  return new Date(new Date(deletedAt).getTime() + WORK_DELETE_RETENTION_DAYS * DAY_MS);
}
