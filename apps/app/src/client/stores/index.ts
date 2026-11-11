/**
 * Barrel: the public store surface for features — re-exports the open-document
 * descriptor, the project and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  isEditorOpenDocument,
  isEditorScheme,
  type OpenDocument,
  replaceOwner,
  type ServerOpenDocument,
  type TabOwner,
  tabContextOwner,
} from "./open-document";
export type { ProjectStoreActions, ProjectStoreState } from "./project-store";
export {
  loadProjectList,
  mergeApiProjects,
  type ProjectStoreApi,
  ProjectStoreProvider,
  type ProjectStoreSeed,
  useProjectActions,
  useProjectStore,
} from "./project-store";
export {
  announce,
  announceError,
  announceErrors,
  clearAnnouncement,
  useAnnouncement,
} from "./thread-store/announcements";
export {
  ThreadStoreProvider,
  useAskReceipt,
  useIsThreadPendingCreation,
  useOpenAsk,
  useRunState,
  useRunStateSlice,
  useThreadActions,
  useThreadAsks,
  useThreadStore,
} from "./thread-store/thread-store";
export type { ThreadStoreActions } from "./thread-store/types";
