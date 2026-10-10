/** This tab's last opened Work, with a device-local starting point for new tabs. */
import { readRememberedId, writeRememberedId } from "./tab-first-remembered-id";

export function readCurrentWork(accountId: string, projectId: string): string | null {
  return readRememberedId("work", accountId, projectId);
}

export function writeCurrentWork(accountId: string, projectId: string, workId: string): void {
  writeRememberedId("work", accountId, projectId, workId);
}
