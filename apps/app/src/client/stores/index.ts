/**
 * Barrel: the public store surface for features — re-exports the independent-
 * projects, project, and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  type ContextTab,
  type ServerContextTab,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
} from "./context-tabs-store";
export {
  markIndependentProject,
  promoteIndependentProject,
  useIndependentProjectIds,
  useIndependentProjectsStore,
  useIsIndependentProject,
} from "./independent-projects";
export type {
  PendingProjectDelete,
  ProjectStoreActions,
  ProjectStoreState,
} from "./project-store";
export {
  getSuppressedProjectListIds,
  loadProjectList,
  mergeApiProjects,
  type ProjectStoreApi,
  ProjectStoreProvider,
  type ProjectStoreSeed,
  useProjectActions,
  useProjectStore,
} from "./project-store";
export { nextUntitledName, type TempDocument, useTempDocsStore } from "./temp-docs-store";
export { announce, announceError, useAnnouncement } from "./thread-store/announcements";
export {
  ThreadStoreProvider,
  useIsProjectPendingCreation,
  useIsThreadPendingCreation,
  useThreadActions,
  useThreadStore,
} from "./thread-store/thread-store";
export type { ThreadStoreActions } from "./thread-store/types";
