/** Public client working-set store and sync-driver surface. */

export {
  bindWorkingSetSyncLifetime,
  configureWorkingSetSync,
  hydrateWorkingSet,
  readRecentRoutes,
  reconcileContextRoutes,
  replaceRecentRoutes,
  retryWorkingSetHydration,
  subscribeWorkingSetHydration,
} from "./driver";
export type { WorkingSetHydrationPlan } from "./hydration";
export type { ReconcileContextRoutesInput } from "./store";
export {
  buildWorkingSetRoute,
  followRouteIdentity,
  reconcileSnapshotContextRoutes,
  replaceSnapshotRoute,
  workingSetRouteEquals,
  workingSetRouteIdentityEquals,
} from "./store";
