/**
 * Barrel: the public store surface for features — re-exports editor-workspace,
 * project, and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  type ContextTab,
  commitContextAvailability,
  commitDraftApplyMetadata,
  commitDraftHold,
  commitPlannedContextRemoval,
  type DraftWorkspaceSettlementReceipt,
  durableContextTab,
  editorTabsForWork,
  getContextTabs,
  isDraftOnly,
  isEditorContextTab,
  isEditorScheme,
  isEditorTab,
  matchesReviewItem,
  matchesTabInstance,
  type OpenEditorTabResult,
  type ProjectTabsSlice,
  parseContextTab,
  type ReviewEntries,
  type ReviewItemTabIdentity,
  reconcileEditorWorkspaceBootstrap,
  rehydrateEditorWorkspace,
  replaceOwner,
  reviewEntriesOf,
  reviewEntryOf,
  type ServerContextTab,
  sameServerContextTabLocator,
  serverContextTabLocatorKey,
  type TabOwner,
  tabContextOwner,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
  withoutReviewEntry,
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
  useThreadStore,
} from "./thread-store/thread-store";
export type { ThreadStoreActions } from "./thread-store/types";
