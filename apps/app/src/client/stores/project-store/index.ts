/**
 * Barrel: re-exports the project store (provider/hooks), its API-merge helper,
 * the SSR list loader, and the store state/action types.
 */
export { mergeApiProjects } from "./merge-api-projects";
export { loadProjectList } from "./project-source";
export {
  createProjectStore,
  type ProjectStoreApi,
  ProjectStoreProvider,
  type ProjectStoreSeed,
  useProjectActions,
  useProjectStore,
} from "./project-store";
export type { ProjectStoreActions, ProjectStoreState } from "./types";
