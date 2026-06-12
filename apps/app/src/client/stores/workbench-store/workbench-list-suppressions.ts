// @ts-nocheck
/** Workbench ids hidden from list merges until undo or server delete completes. */
const suppressed = new Set<string>();

export function suppressWorkbenchListId(id: string): void {
  suppressed.add(id);
}

export function unsuppressWorkbenchListId(id: string): void {
  suppressed.delete(id);
}

export function getSuppressedWorkbenchListIds(): ReadonlySet<string> {
  return suppressed;
}
