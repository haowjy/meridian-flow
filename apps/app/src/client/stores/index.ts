// @ts-nocheck
/**
 * Barrel: the public store surface for features — re-exports the independent-
 * workbenches, layout, workbench, and thread stores plus announcements. Features
 * import from `@/client/stores` only, never store internals.
 */

export {
  type ContextTab,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
} from "./context-tabs-store";
export {
  markIndependentWorkbench,
  promoteIndependentWorkbench,
  useIndependentWorkbenchesStore,
  useIndependentWorkbenchIds,
  useIsIndependentWorkbench,
} from "./independent-workbenches";
export {
  type LayoutActions,
  type LayoutState,
  useLayoutActions,
  useLayoutStore,
} from "./layout-store";
export { announce, announceError, useAnnouncement } from "./thread-store/announcements";
export {
  ThreadStoreProvider,
  useIsThreadPendingCreation,
  useIsWorkbenchPendingCreation,
  useThreadActions,
  useThreadStore,
} from "./thread-store/thread-store";
export type { ThreadStoreActions } from "./thread-store/types";
export type {
  PendingWorkbenchDelete,
  WorkbenchStoreActions,
  WorkbenchStoreState,
} from "./workbench-store";
export {
  getSuppressedWorkbenchListIds,
  loadWorkbenchList,
  mergeApiWorkbenches,
  useWorkbenchActions,
  useWorkbenchStore,
  type WorkbenchStoreApi,
  WorkbenchStoreProvider,
  type WorkbenchStoreSeed,
} from "./workbench-store";
