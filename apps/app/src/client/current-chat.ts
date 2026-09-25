/**
 * This browser's current chat in each project: the chat the Chat screen and
 * the dock reopen. Device-local and never synced, so each device keeps its own
 * place. `null` is no chat: the next chat starts from an empty composer.
 */
export const CURRENT_CHAT_STORAGE_PREFIX = "meridian:current-chat";

export function currentChatStorageKey(accountId: string, projectId: string): string {
  return `${CURRENT_CHAT_STORAGE_PREFIX}:${accountId}:${projectId}`;
}

export function readCurrentChat(accountId: string, projectId: string): string | null {
  try {
    return window.localStorage.getItem(currentChatStorageKey(accountId, projectId)) || null;
  } catch {
    return null;
  }
}

export function writeCurrentChat(
  accountId: string,
  projectId: string,
  threadId: string | null,
): void {
  try {
    const key = currentChatStorageKey(accountId, projectId);
    if (threadId) window.localStorage.setItem(key, threadId);
    else window.localStorage.removeItem(key);
  } catch {
    // Remembering the chat is best-effort when storage is unavailable.
  }
}
