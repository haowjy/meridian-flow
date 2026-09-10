/** Public client working-set store and sync-driver surface. */

export {
  configureWorkingSetSync,
  hydrateWorkingSet,
  readRecentRoutes,
  readRememberedThread,
  reconcileContextRoutes,
  replaceRecentRoutes,
  retryWorkingSetHydration,
  setThread,
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
