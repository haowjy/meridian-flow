/** Pure eligibility and continuity planning for one exact context-removal intent. */

import { workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import {
  type ContextTab,
  editorTabsForWork,
  isDraftOnly,
  reviewOwners,
  withoutReviewEntry,
} from "@/client/stores";
import {
  buildWorkingSetRoute,
  type ReconcileContextRoutesInput,
  workingSetRouteEquals,
} from "@/client/working-set";
import { type ContextRouteTarget, sameContextTarget } from "../routing/project-route";

export type ContextRemovalIntent = {
  cause:
    | "writer-close"
    | "catalog-unavailable"
    | "authority-unavailable"
    | "work-prune"
    | "draft-discard";
  documentIds: readonly string[];
  /** Writer close and draft settlement address a mounted tab, not every document representation. */
  tabInstanceId?: string;
  /** Discard and a writer's close of a draft-only tab are one Work's: the tab stays while another Work still reviews the document. */
  reviewOwner?: string;
};

export type ContextRouteIdentity = { kind: "server" | "local"; documentId: string };

export type RouteContinuityVerdict =
  | { kind: "none" }
  | {
      kind: "bound";
      revision: number;
      locator: ContextRouteTarget;
      identity: ContextRouteIdentity;
    }
  | {
      kind: "proven-removed";
      revision: number;
      locator: ContextRouteTarget;
      identity: ContextRouteIdentity;
    };

export type ContextRemovalOutcome =
  | { kind: "noop" }
  | {
      kind: "removal";
      removed: readonly ContextTab[];
      workspaceSelectedRemoved: boolean;
      routedDocumentRemoved: boolean;
      remaining: readonly ContextTab[];
    };

export type ContextRemovalPlan = {
  outcome: ContextRemovalOutcome;
  admitted: ContextRouteTarget | null;
  workingSet: ReconcileContextRoutesInput;
};

export type ContextRemovalPlannerInput = {
  activeWorkId: string | null;
  tabs: readonly ContextTab[];
  selectedTabId: string | null;
  admitted: ContextRouteTarget | null;
  route: {
    cleanup: ExactRouteCleanup | null;
    current: RouteContinuityVerdict;
  };
  intent: ContextRemovalIntent;
};

export type ExactRouteCleanup = {
  revision: number;
  locator: ContextRouteTarget;
  identity: ContextRouteIdentity;
};

/** A rejected candidate leaves the address as written: the view says the document is gone. */
export function planCandidateRejection(input: {
  rejected: ContextRouteTarget;
  tabs: readonly ContextTab[];
  admitted: ContextRouteTarget | null;
  recentRoutes: readonly WorkingSetRoute[];
}): { admitted: ContextRouteTarget | null; workingSet: ReconcileContextRoutesInput } {
  const rejectedRoute = input.recentRoutes.find((route) =>
    workingSetRouteMatchesTarget(route, input.rejected),
  );
  return {
    admitted:
      input.admitted && sameContinuityLocator(input.admitted, input.rejected)
        ? null
        : input.admitted,
    workingSet: {
      removedLocators: rejectedRoute ? [rejectedRoute] : [],
      survivingOwnedLocators: input.tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
      promote: null,
      clearAll: false,
    },
  };
}

export function contextTabEligibleForRemoval(
  tab: ContextTab,
  intent: ContextRemovalIntent,
): boolean {
  if (!intent.documentIds.includes(tab.documentId)) return false;
  if (intent.tabInstanceId !== undefined && tab.tabInstanceId !== intent.tabInstanceId)
    return false;
  switch (intent.cause) {
    case "writer-close":
      return true;
    case "catalog-unavailable":
    case "authority-unavailable":
      return tab.kind !== "new" && !isDraftOnly(tab);
    case "work-prune":
      return (
        tab.kind !== "new" &&
        (tab.kind !== "tracked" || tab.origin !== "local-resource") &&
        isWorkScopedScheme(tab.scheme)
      );
    case "draft-discard":
      return tab.kind !== "new" && isDraftOnly(tab);
  }
}

export function workingSetRouteForTab(tab: ContextTab) {
  // A route names a document the server holds: it answers the whole snapshot with a 400 when
  // one is missing, so a local-only document's route waits for its materialization.
  if (tab.kind === "new" || (tab.kind === "tracked" && tab.localOnly)) return null;
  return buildWorkingSetRoute(tab.documentId, tab.scheme, tab.path, tab);
}

export function routeTargetForTab(tab: ContextTab, activeWorkId: string): ContextRouteTarget {
  if (tab.kind === "new")
    return { scheme: "unfiled", path: "", workId: activeWorkId, documentId: tab.documentId };
  if (tab.rootThreadId)
    return {
      scheme: tab.scheme,
      path: tab.path,
      workId: activeWorkId,
      rootThreadId: tab.rootThreadId,
      documentId: tab.documentId,
    };
  const reviewers = reviewOwners(tab).flatMap((key) => workIdOfDraftOwnerKey(key) ?? []);
  let workId = reviewers.includes(activeWorkId) ? activeWorkId : (reviewers[0] ?? activeWorkId);
  if (isWorkScopedScheme(tab.scheme)) {
    if (!tab.workId) throw new Error("Work-scoped tab has no Work owner");
    workId = tab.workId;
  }
  return { scheme: tab.scheme, path: tab.path, workId, documentId: tab.documentId };
}

/** The tab a target names: by its document when it carries one, else by locator. */
export function tabForTarget(
  tabs: readonly ContextTab[],
  target: ContextRouteTarget,
  activeWorkId: string,
): ContextTab | null {
  return (
    tabs.find((tab) =>
      target.documentId !== undefined
        ? tab.documentId === target.documentId
        : sameTarget(routeTargetForTab(tab, activeWorkId), target),
    ) ?? null
  );
}

/** Query/cache state is deliberately absent: exact commands are the only removal evidence. */
export function planContextRemoval(input: ContextRemovalPlannerInput): ContextRemovalPlan {
  const requested = new Set(input.intent.documentIds);
  const removed = input.tabs.filter((tab) => contextTabEligibleForRemoval(tab, input.intent));
  const removedIds = new Set(removed.map((tab) => tab.documentId));
  // The membership after the removal, decided once: a review removal can leave
  // the tab in place for the Works that still present it.
  const reviewOwner = input.intent.reviewOwner;
  const remaining = input.tabs.flatMap((tab) => {
    if (!removedIds.has(tab.documentId)) return [tab];
    return (reviewOwner && withoutReviewEntry(tab, reviewOwner)) || [];
  });
  if (input.activeWorkId === null) {
    // Before any route port registers there is no Editor locator to repair.
    return {
      outcome: removed.length
        ? {
            kind: "removal",
            removed,
            workspaceSelectedRemoved: false,
            routedDocumentRemoved: false,
            remaining,
          }
        : { kind: "noop" },
      admitted: null,
      workingSet: {
        removedLocators: removed.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
        survivingOwnedLocators: remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
        promote: null,
        clearAll: false,
      },
    };
  }
  const activeWorkId = input.activeWorkId;
  const visibleRemaining = editorTabsForWork(remaining, activeWorkId);
  const survives = (documentId: string) =>
    visibleRemaining.some((tab) => tab.documentId === documentId);
  const workspaceSelectedRemoved =
    input.selectedTabId !== null &&
    removedIds.has(input.selectedTabId) &&
    !survives(input.selectedTabId);
  const boundSelection = input.route.current.kind === "bound" ? input.route.current : null;
  const provenRemoved = input.route.current.kind === "proven-removed" ? input.route.current : null;
  const routedDocumentRemoved =
    provenRemoved !== null &&
    requested.has(provenRemoved.identity.documentId) &&
    !survives(provenRemoved.identity.documentId);
  const exactCleanup =
    input.route.cleanup !== null &&
    requested.has(input.route.cleanup.identity.documentId) &&
    !survives(input.route.cleanup.identity.documentId);

  const admitted = input.admitted;
  // The bound document's own tab: another tab may cache the same locator.
  const admittedTab = admitted
    ? tabForTarget(
        input.tabs,
        boundSelection && sameTarget(boundSelection.locator, admitted)
          ? { ...admitted, documentId: boundSelection.identity.documentId }
          : admitted,
        activeWorkId,
      )
    : null;
  const admittedRoute = admittedTab
    ? workingSetRouteForTab(admittedTab)
    : input.admitted && boundSelection && sameTarget(boundSelection.locator, input.admitted)
      ? workingSetRouteForTarget(boundSelection.identity.documentId, input.admitted)
      : null;
  const survivingRoutes = remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []);
  const removedTabRoutes = removed
    .flatMap((tab) => workingSetRouteForTab(tab) ?? [])
    .filter((route) => !survivingRoutes.some((survivor) => workingSetRouteEquals(survivor, route)));
  const admittedWasRemoved =
    input.admitted !== null &&
    ((provenRemoved !== null && sameTarget(provenRemoved.locator, input.admitted)) ||
      (input.route.cleanup !== null &&
        sameTarget(input.route.cleanup.locator, input.admitted) &&
        !(
          boundSelection !== null &&
          sameTarget(boundSelection.locator, input.admitted) &&
          boundSelection.identity.documentId !== input.route.cleanup.identity.documentId
        )) ||
      removedTabRoutes.some((route) =>
        workingSetRouteMatchesTarget(route, input.admitted as ContextRouteTarget),
      ));
  const survivingAdmittedRoute = admittedWasRemoved ? null : admittedRoute;

  if (removed.length === 0 && !routedDocumentRemoved && !exactCleanup) {
    return {
      outcome: { kind: "noop" },
      admitted: input.admitted,
      workingSet: {
        removedLocators: [],
        survivingOwnedLocators: [
          ...input.tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          ...(survivingAdmittedRoute ? [survivingAdmittedRoute] : []),
        ],
        promote: survivingAdmittedRoute,
        clearAll: false,
      },
    };
  }

  const removedLocators = [...removedTabRoutes];
  const cleanup = input.route.cleanup;
  if (cleanup && exactCleanup) {
    const cleanupRoute = workingSetRouteForTarget(cleanup.identity.documentId, cleanup.locator);
    if (cleanupRoute) removedLocators.push(cleanupRoute);
  }
  // The routed document's own tab, when it survives, is what stays admitted.
  const survivingRoutedTab =
    boundSelection && !routedDocumentRemoved
      ? (visibleRemaining.find((tab) => tab.documentId === boundSelection.identity.documentId) ??
        null)
      : null;
  const survivingRoutedTarget = survivingRoutedTab
    ? routeTargetForTab(survivingRoutedTab, activeWorkId)
    : null;
  const survivingRoutedIsUnadmittedBinding =
    survivingRoutedTarget !== null &&
    boundSelection !== null &&
    sameTarget(survivingRoutedTarget, boundSelection.locator) &&
    (input.admitted === null || !sameTarget(input.admitted, boundSelection.locator));
  const nextAdmitted = survivingRoutedIsUnadmittedBinding ? null : survivingRoutedTarget;
  const promote =
    survivingAdmittedRoute ??
    (nextAdmitted && survivingRoutedTab ? workingSetRouteForTab(survivingRoutedTab) : null);

  return {
    outcome: {
      kind: "removal",
      removed,
      workspaceSelectedRemoved,
      routedDocumentRemoved,
      remaining,
    },
    admitted: input.admitted && !admittedWasRemoved ? input.admitted : nextAdmitted,
    workingSet: {
      removedLocators,
      survivingOwnedLocators: [
        ...remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
        ...(survivingAdmittedRoute ? [survivingAdmittedRoute] : []),
      ],
      promote,
      // Exact locator removal is sufficient. A broad clear would erase unrelated
      // account-owned continuity that is intentionally not represented in this workspace.
      clearAll: false,
    },
  };
}

const sameTarget = sameContextTarget;

function workingSetRouteMatchesTarget(route: WorkingSetRoute, target: ContextRouteTarget): boolean {
  return (
    route.scheme === target.scheme &&
    route.path === target.path &&
    route.rootThreadId === target.rootThreadId &&
    (!isWorkScopedScheme(route.scheme) ||
      route.rootThreadId !== undefined ||
      route.workId === target.workId)
  );
}

export function workingSetRouteForTarget(
  documentId: string,
  locator: ContextRouteTarget,
): WorkingSetRoute | null {
  return buildWorkingSetRoute(documentId, locator.scheme, locator.path, locator);
}

function sameContinuityLocator(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return (
    a.scheme === b.scheme &&
    a.path === b.path &&
    a.rootThreadId === b.rootThreadId &&
    (!isWorkScopedScheme(a.scheme) || a.rootThreadId !== undefined || a.workId === b.workId)
  );
}
