// @ts-nocheck
/** Project ids hidden from list merges until undo or server delete completes. */
const suppressed = new Set<string>();

export function suppressProjectListId(id: string): void {
  suppressed.add(id);
}

export function unsuppressProjectListId(id: string): void {
  suppressed.delete(id);
}

export function getSuppressedProjectListIds(): ReadonlySet<string> {
  return suppressed;
}
