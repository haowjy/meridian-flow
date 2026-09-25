/** Public client working-set store and sync-driver surface. */

export {
  type CurrentChat,
  configureWorkingSetSync,
  hydrateWorkingSet,
  readCurrentChat,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
  retryWorkingSetHydration,
  setCurrentChat,
} from "./driver";
export type { WorkingSetHydrationPlan } from "./hydration";
export type { ReconcileContextRoutesInput } from "./store";
export {
  buildWorkingSetRoute,
  recentRouteForEditorWork,
  reconcileSnapshotContextRoutes,
  replaceSnapshotRoute,
  workingSetRouteEquals,
  workingSetRouteIdentityEquals,
} from "./store";
