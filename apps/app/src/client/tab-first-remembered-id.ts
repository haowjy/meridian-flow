/** Tab-local selection, with a device seed only for a tab's first read. */
import { browserRecord } from "./storage/browser-record";

export function rememberedIdKey(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
): string {
  return `meridian:current-${kind}:v1:${accountId}:${projectId}`;
}

function selectionRecord(
  storage: "session" | "local",
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
) {
  return browserRecord<string | null>(
    storage,
    {
      key: rememberedIdKey(kind, accountId, projectId),
      version: 1,
      accountId,
      scope: JSON.stringify([projectId, kind]),
    },
    (value) =>
      value === null || (typeof value === "string" && value.length > 0) ? value : undefined,
  );
}

export function readRememberedId(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
): string | null {
  const tabRecord = selectionRecord("session", kind, accountId, projectId);
  const tab = tabRecord.read();
  if (tab !== undefined) return tab;
  const seed = selectionRecord("local", kind, accountId, projectId).read() ?? null;
  // Freeze even an empty seed, so another tab cannot choose this tab's chat later.
  tabRecord.write(seed);
  return seed;
}

export function writeRememberedId(
  kind: "chat" | "work",
  accountId: string,
  projectId: string,
  id: string | null,
): void {
  const tabRecord = selectionRecord("session", kind, accountId, projectId);
  // Independent attempts: a failed tab write must not prevent updating the seed.
  tabRecord.write(id);
  selectionRecord("local", kind, accountId, projectId).write(id);
}
