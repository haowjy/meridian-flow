/** Working-set snapshot copying keeps repository callers from sharing mutable route arrays. */
import type { WorkingSetRow, WorkingSetSnapshot } from "./ports/working-set-repository.js";

export function copyWorkingSetSnapshot(snapshot: WorkingSetSnapshot): WorkingSetSnapshot {
  return {
    recentRoutes: snapshot.recentRoutes.map((route) => ({ ...route })),
    lastThreadId: snapshot.lastThreadId,
  };
}

export function copyWorkingSetRow(row: WorkingSetRow): WorkingSetRow {
  return { ...row, ...copyWorkingSetSnapshot(row), updatedAt: new Date(row.updatedAt) };
}
