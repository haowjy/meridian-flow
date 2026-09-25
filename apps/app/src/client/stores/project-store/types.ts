/**
 * project-store types — the project store's state/action contracts. Read
 * surface (`ProjectStoreState`) vs write surface (`ProjectStoreActions`); the
 * canonical project store vocabulary.
 */
import type { ProjectDto as Project } from "@meridian/contracts/projects";

/** Read surface — subscribe with `useProjectStore((s) => …)`. */
export type ProjectStoreState = {
  /**
   * Stable reference time (epoch ms) for date bucketing and relative-time
   * labels. From the authenticated route loader.
   */
  now: number;
};

/** Mutations — use `useProjectActions()` only. Do not call from selectors. */
export type ProjectStoreActions = {
  ensureProject(project: Project): void;
};
