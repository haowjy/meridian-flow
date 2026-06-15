/**
 * project-store types — the project store's state/action contracts plus the
 * pending soft-delete shape. Read surface (`ProjectStoreState`) vs write surface
 * (`ProjectStoreActions`); the canonical project store vocabulary.
 */
import type { Project } from "@meridian/contracts/projects";

export type PendingProjectDelete = {
  project: Project;
  /** Epoch ms from `store.now` when delete fired (undo pill countdown). */
  deletedAt: number;
};

/** Read surface — subscribe with `useProjectStore((s) => …)`. */
export type ProjectStoreState = {
  /**
   * Stable reference time (epoch ms) for date bucketing and relative-time
   * labels. From the authenticated route loader.
   */
  now: number;
  pendingDelete: PendingProjectDelete | null;
};

/** Mutations — use `useProjectActions()` only. Do not call from selectors. */
export type ProjectStoreActions = {
  ensureProject(project: Project): void;
  rename(id: string, title: string): void;
  /** Returns false when the project could not be removed (e.g. list not loaded). */
  softDelete(id: string, source?: Project): boolean;
  undoSoftDelete(id: string): void;
  finalizeSoftDelete(id: string): void;
};
