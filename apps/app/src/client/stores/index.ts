/**
 * Barrel: the public store surface for features — re-exports editor-workspace,
 * project, and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  type ContextTab,
  commitContextAvailability,
  commitDraftApplyMetadata,
  commitPlannedContextRemoval,
  commitReviewOverlayClose,
  type DraftWorkspaceSettlementReceipt,
  getContextTabs,
  isEditorContextTab,
  isEditorScheme,
  isEditorTab,
  type OpenEditorTabResult,
  type ProjectTabsSlice,
  previewReviewOverlayClose,
  type ReviewOverlayConsumeReceipt,
  type ReviewOverlayTabIdentity,
  reconcileEditorWorkspaceBootstrap,
  rehydrateEditorWorkspace,
  replaceOwner,
  type ServerContextTab,
  serverContextTabLocatorKey,
  type TabOwner,
  tabContextOwner,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
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
export { announce, announceError, useAnnouncement } from "./thread-store/announcements";
export {
  ThreadStoreProvider,
  useIsThreadPendingCreation,
  useThreadActions,
  useThreadStore,
} from "./thread-store/thread-store";
export type { PendingStreamStart, ThreadStoreActions } from "./thread-store/types";
