/**
 * Barrel: re-exports the project store (provider/hooks), its API-merge and
 * suppression helpers, the SSR list loader, and the store state/action types.
 */
export { mergeApiProjects } from "./merge-api-projects";
export { getSuppressedProjectListIds } from "./project-list-suppressions";
export { loadProjectList } from "./project-source";
export {
  createProjectStore,
  type ProjectStoreApi,
  ProjectStoreProvider,
  type ProjectStoreSeed,
  useProjectActions,
  useProjectStore,
} from "./project-store";
export type {
  PendingProjectDelete,
  ProjectStoreActions,
  ProjectStoreState,
} from "./types";
