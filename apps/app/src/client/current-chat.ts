/** This tab's current chat, with a device-local starting point for new tabs. */
import { readRememberedId, writeRememberedId } from "./tab-first-remembered-id";

export function readCurrentChat(accountId: string, projectId: string): string | null {
  return readRememberedId("chat", accountId, projectId);
}

export function writeCurrentChat(
  accountId: string,
  projectId: string,
  threadId: string | null,
): void {
  writeRememberedId("chat", accountId, projectId, threadId);
}
