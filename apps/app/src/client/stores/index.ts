/**
 * Barrel: the public store surface for features — re-exports editor-workspace,
 * project, and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  type ContextTab,
  commitContextAvailability,
  commitPlannedContextRemoval,
  getContextTabs,
  isEditorContextTab,
  isEditorScheme,
  matchesTabInstance,
  type OpenEditorTabResult,
  type ProjectTabsSlice,
  reconcileEditorWorkspaceBootstrap,
  rehydrateEditorWorkspace,
  replaceOwner,
  type ServerContextTab,
  selectedDocumentIdOf,
  selectedTabOf,
  selectingDocument,
  type TabOwner,
  tabContextOwner,
  tabKey,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
  useSelectedContextTab,
  useSelectedDocumentId,
} from "./context-tabs-store";
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
