/** Tab-local tree arrangement, scoped to the account, project, and tree owner. */
export type TreeExpansion = { expanded: boolean; entries: Record<string, boolean> };
export const EMPTY_TREE_EXPANSION: TreeExpansion = { expanded: false, entries: {} };

export function treeExpansionKey(accountId: string, projectId: string, scope: string): string {
  return `meridian:tree-expansion:v1:${JSON.stringify([accountId, projectId, scope])}`;
}

export function readTreeExpansion(key: string): TreeExpansion {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return EMPTY_TREE_EXPANSION;
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      value.key !== key ||
      typeof value.expanded !== "boolean" ||
      !value.entries ||
      typeof value.entries !== "object" ||
      Array.isArray(value.entries) ||
      Object.values(value.entries).some((open) => typeof open !== "boolean")
    )
      return EMPTY_TREE_EXPANSION;
    return { expanded: value.expanded, entries: value.entries };
  } catch {
    return EMPTY_TREE_EXPANSION;
  }
}

export function writeTreeExpansion(key: string, state: TreeExpansion): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ version: 1, key, ...state }));
  } catch {
    // The live tree remains usable when browser storage is blocked or full.
  }
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
