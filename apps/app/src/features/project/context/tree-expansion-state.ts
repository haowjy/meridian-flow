/** Tab-local tree arrangement, scoped to the account, project, and tree owner. */
import { browserRecord, isRecord } from "@/client/storage/browser-record";

export type TreeExpansion = { expanded: boolean; entries: Record<string, boolean> };
export const EMPTY_TREE_EXPANSION: TreeExpansion = { expanded: false, entries: {} };

export function treeExpansionKey(accountId: string, projectId: string, scope: string): string {
  return `meridian:tree-expansion:v1:${JSON.stringify([accountId, projectId, scope])}`;
}

function treeRecord(key: string, accountId: string) {
  return browserRecord<TreeExpansion>(
    "session",
    { key, version: 1, accountId, scope: key },
    (input) => {
      if (!isRecord(input)) return undefined;
      if (
        typeof input.expanded !== "boolean" ||
        !isRecord(input.entries) ||
        Object.values(input.entries).some((open) => typeof open !== "boolean")
      )
        return undefined;
      return { expanded: input.expanded, entries: input.entries as Record<string, boolean> };
    },
  );
}

export function readTreeExpansion(key: string, accountId: string): TreeExpansion {
  return treeRecord(key, accountId).read() ?? EMPTY_TREE_EXPANSION;
}

export function writeTreeExpansion(key: string, accountId: string, state: TreeExpansion): void {
  treeRecord(key, accountId).write(state);
}

export function pruneTreeExpansion(
  state: TreeExpansion,
  folderIds: readonly string[],
): TreeExpansion {
  const existing = new Set(folderIds);
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(([id]) => existing.has(id)),
  );
  return Object.keys(entries).length === Object.keys(state.entries).length
    ? state
    : { ...state, entries };
}

/** Walk all folders, including those hidden by a collapsed ancestor. */
export function treeFolderIds(children: (parent: string | null) => readonly string[]): string[] {
  const ids: string[] = [];
  const visit = (parent: string | null) => {
    for (const id of children(parent)) {
      ids.push(id);
      visit(id);
    }
  };
  visit(null);
  return ids;
}
