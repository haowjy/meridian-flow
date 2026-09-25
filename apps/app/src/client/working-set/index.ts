/** Public client working-set store and sync-driver surface. */

export {
  configureWorkingSetSync,
  hydrateWorkingSet,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
  retryWorkingSetHydration,
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
