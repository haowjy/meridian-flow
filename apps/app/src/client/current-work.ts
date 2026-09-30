/**
 * This browser's last opened Work in each project: the Work the sidebar's Work
 * destination reopens and the Work collection offers as a tab back. Device-local
 * and never synced, like the current chat.
 */
export const CURRENT_WORK_STORAGE_PREFIX = "meridian:current-work";

function key(accountId: string, projectId: string): string {
  return `${CURRENT_WORK_STORAGE_PREFIX}:${accountId}:${projectId}`;
}

export function readCurrentWork(accountId: string, projectId: string): string | null {
  try {
    return window.localStorage.getItem(key(accountId, projectId)) || null;
  } catch {
    return null;
  }
}

export function writeCurrentWork(accountId: string, projectId: string, workId: string): void {
  try {
    window.localStorage.setItem(key(accountId, projectId), workId);
  } catch {
    // Remembering the Work is best-effort when storage is unavailable.
  }
}
