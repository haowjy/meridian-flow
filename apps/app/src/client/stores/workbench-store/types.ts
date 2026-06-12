// @ts-nocheck
/**
 * workbench-store types — the workbench store's state/action contracts plus the
 * pending soft-delete shape. Read surface (`WorkbenchStoreState`) vs write surface
 * (`WorkbenchStoreActions`); the canonical workbench store vocabulary.
 */
import type { Workbench } from "@meridian/contracts/workbenches";

export type PendingWorkbenchDelete = {
  workbench: Workbench;
  /** Epoch ms from `store.now` when delete fired (undo pill countdown). */
  deletedAt: number;
};

/** Read surface — subscribe with `useWorkbenchStore((s) => …)`. */
export type WorkbenchStoreState = {
  /**
   * Stable reference time (epoch ms) for date bucketing and relative-time
   * labels. From the authenticated route loader.
   */
  now: number;
  pendingDelete: PendingWorkbenchDelete | null;
};

/** Mutations — use `useWorkbenchActions()` only. Do not call from selectors. */
export type WorkbenchStoreActions = {
  ensureWorkbench(workbench: Workbench): void;
  rename(id: string, title: string): void;
  /** Returns false when the workbench could not be removed (e.g. list not loaded). */
  softDelete(id: string, source?: Workbench): boolean;
  undoSoftDelete(id: string): void;
  finalizeSoftDelete(id: string): void;
};
