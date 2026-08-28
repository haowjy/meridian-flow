/** Pure eligibility and continuity planning for one exact context-removal intent. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { buildWorkingSetRoute, type ReconcileContextRoutesInput } from "@/client/working-set";
import type { ContextRouteRepair, ContextRouteTarget } from "../routing/project-route";

export type ContextRemovalIntent = {
  cause: "writer-close" | "acknowledged-delete" | "work-prune" | "draft-discard";
  documentIds: readonly string[];
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
      kind: "inactive-removal";
      removed: readonly ContextTab[];
      deskActiveRemoved: false;
      routedDocumentRemoved: false;
      remaining: readonly ContextTab[];
    }
  | {
      kind: "active-fallback";
      removed: readonly ContextTab[];
      deskActiveRemoved: boolean;
      routedDocumentRemoved: boolean;
      fallback: ContextTab;
      remaining: readonly ContextTab[];
    }
  | {
      kind: "empty-desk";
      removed: readonly ContextTab[];
      deskActiveRemoved: boolean;
      routedDocumentRemoved: boolean;
      remaining: readonly [];
    }
  | {
      kind: "route-only-removal";
      removed: readonly [];
      routedDocumentRemoved: true;
      remaining: readonly ContextTab[];
    }
  | {
      kind: "exact-route-cleanup";
      removed: readonly [];
      deskActiveRemoved: false;
      routedDocumentRemoved: false;
      remaining: readonly ContextTab[];
    };

export type ContextRemovalPlan = {
  outcome: ContextRemovalOutcome;
  nextActiveTabId: string | null;
  admitted: ContextRouteTarget | null;
  routeRepairTarget: ContextRouteTarget | { kind: "clear" } | null;
  workingSet: ReconcileContextRoutesInput;
};

export type ContextRemovalPlannerInput = {
  tabs: readonly ContextTab[];
  activeTabId: string | null;
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

export type CandidateRejectionPlan = {
  expected: { revision: number; locator: ContextRouteTarget };
  fallback: ContextRouteTarget | null;
  deskSelection: { kind: "preserve" } | { kind: "select"; documentId: string };
  workingSet: ReconcileContextRoutesInput;
  repair: ContextRouteRepair;
};

export function planCandidateRejection(input: {
  revision: number;
  rejected: ContextRouteTarget;
  activeWorkId: string | null;
  tabs: readonly ContextTab[];
  activeTabId: string | null;
  admitted: ContextRouteTarget | null;
  recentRoutes: readonly WorkingSetRoute[];
}): CandidateRejectionPlan {
  const fallback = chooseAdmittedFallback({ ...input, excluded: input.rejected });
  const fallbackTab = fallback
    ? input.tabs.find((tab) => sameTarget(routeTargetForTab(tab, fallback.workId), fallback))
    : null;
  const rejectedRoute = workingSetRouteForTarget(input.rejected);
  const fallbackRoute = fallback ? workingSetRouteForTarget(fallback) : null;
  return {
    expected: { revision: input.revision, locator: input.rejected },
    fallback,
    deskSelection:
      fallbackTab && fallbackTab.documentId !== input.activeTabId
        ? { kind: "select", documentId: fallbackTab.documentId }
        : { kind: "preserve" },
    workingSet: {
      removedLocators: rejectedRoute ? [rejectedRoute] : [],
      survivingOwnedLocators: [
        ...input.tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
        ...(fallbackRoute ? [fallbackRoute] : []),
      ],
      promote: fallbackRoute,
      clearAll: false,
    },
    repair: {
      expectedSearch: {
        screen: "context",
        work: input.rejected.workId ?? undefined,
        scheme: input.rejected.scheme,
        path: input.rejected.path,
      },
      expectedSelection: { kind: "rejected-candidate", revision: input.revision },
      next: fallback ?? { kind: "clear" },
    },
  };
}

export function contextTabEligibleForRemoval(
  tab: ContextTab,
  intent: ContextRemovalIntent,
): boolean {
  if (!intent.documentIds.includes(tab.documentId)) return false;
  switch (intent.cause) {
    case "writer-close":
      return true;
    case "acknowledged-delete":
      return tab.kind !== "new" && !tab.draftOnly;
    case "work-prune":
      return tab.kind !== "new" && isWorkScopedProjectContextScheme(tab.scheme);
    case "draft-discard":
      return tab.kind !== "new" && tab.draftOnly === true;
  }
}

export function workingSetRouteForTab(tab: ContextTab) {
  return tab.kind === "new" ? null : buildWorkingSetRoute(tab.scheme, tab.path, tab.workId);
}

export function routeTargetForTab(
  tab: ContextTab,
  activeWorkId: string | null,
): ContextRouteTarget {
  if (tab.kind === "new") return { scheme: "scratch", path: "", workId: activeWorkId };
  return {
    scheme: tab.scheme,
    path: tab.path,
    workId: isWorkScopedProjectContextScheme(tab.scheme) ? (tab.workId ?? null) : activeWorkId,
  };
}

function adjacentSurvivor(
  tabs: readonly ContextTab[],
  remaining: readonly ContextTab[],
  anchorDocumentId: string | null,
): ContextTab | null {
  if (!anchorDocumentId) return remaining[0] ?? null;
  const anchor = tabs.findIndex((tab) => tab.documentId === anchorDocumentId);
  if (anchor < 0) return remaining[0] ?? null;
  const surviving = new Set(remaining.map((tab) => tab.documentId));
  return (
    tabs.slice(anchor + 1).find((tab) => surviving.has(tab.documentId)) ??
    tabs
      .slice(0, anchor)
      .reverse()
      .find((tab) => surviving.has(tab.documentId)) ??
    null
  );
}

/** Query/cache state is deliberately absent: exact commands are the only removal evidence. */
export function planContextRemoval(input: ContextRemovalPlannerInput): ContextRemovalPlan {
  const requested = new Set(input.intent.documentIds);
  const removed = input.tabs.filter((tab) => contextTabEligibleForRemoval(tab, input.intent));
  const removedIds = new Set(removed.map((tab) => tab.documentId));
  const remaining = input.tabs.filter((tab) => !removedIds.has(tab.documentId));
  const deskActiveRemoved = input.activeTabId !== null && removedIds.has(input.activeTabId);
  const boundSelection = input.route.current.kind === "bound" ? input.route.current : null;
  const provenRemoved = input.route.current.kind === "proven-removed" ? input.route.current : null;
  const routedDocumentRemoved =
    provenRemoved !== null && requested.has(provenRemoved.identity.documentId);
  const exactCleanup =
    input.route.cleanup !== null && requested.has(input.route.cleanup.identity.documentId);

  const current = boundSelection ?? provenRemoved;
  const admittedRoute = input.admitted ? workingSetRouteForTarget(input.admitted) : null;
  const removedTabRoutes = removed.flatMap((tab) => workingSetRouteForTab(tab) ?? []);
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
      nextActiveTabId: input.activeTabId,
      admitted: input.admitted,
      routeRepairTarget: null,
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

  const routedIdentity = boundSelection?.identity ?? provenRemoved?.identity ?? null;
  const routedTab = routedIdentity
    ? (input.tabs.find((tab) => tab.documentId === routedIdentity.documentId) ?? null)
    : null;
  const survivingRoutedTab =
    boundSelection && !routedDocumentRemoved
      ? (remaining.find((tab) => tab.documentId === boundSelection.identity.documentId) ?? null)
      : null;
  const anchorDocumentId = routedDocumentRemoved
    ? (routedTab?.documentId ?? null)
    : deskActiveRemoved
      ? input.activeTabId
      : null;
  const fallback =
    routedDocumentRemoved || deskActiveRemoved
      ? adjacentSurvivor(input.tabs, remaining, anchorDocumentId)
      : null;
  const selectedFallback = deskActiveRemoved && survivingRoutedTab ? survivingRoutedTab : fallback;
  const nextActiveTabId = deskActiveRemoved
    ? (selectedFallback?.documentId ?? null)
    : routedDocumentRemoved
      ? (fallback?.documentId ?? null)
      : input.activeTabId;
  const removedLocators = [...removedTabRoutes];
  const cleanup = input.route.cleanup;
  if (cleanup && exactCleanup) {
    const cleanupRoute = workingSetRouteForTarget(cleanup.locator);
    if (cleanupRoute) removedLocators.push(cleanupRoute);
  }
  const survivingOwnedLocators = [
    ...remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
    ...(survivingAdmittedRoute ? [survivingAdmittedRoute] : []),
  ];
  const promotedTab = survivingRoutedTab ?? fallback;
  const promotedTarget = promotedTab
    ? routeTargetForTab(promotedTab, current?.locator.workId ?? null)
    : null;
  const promotedTargetIsUnadmittedBinding =
    promotedTarget !== null &&
    boundSelection !== null &&
    sameTarget(promotedTarget, boundSelection.locator) &&
    (input.admitted === null || !sameTarget(input.admitted, boundSelection.locator));
  const admittedFallback = promotedTargetIsUnadmittedBinding ? null : promotedTarget;
  const promote =
    survivingAdmittedRoute ??
    (admittedFallback ? workingSetRouteForTarget(admittedFallback) : null);
  const routeRepairTarget = routedDocumentRemoved
    ? fallback
      ? routeTargetForTab(fallback, current?.locator.workId ?? null)
      : ({ kind: "clear" } as const)
    : null;

  let outcome: ContextRemovalOutcome;
  if (removed.length === 0 && routedDocumentRemoved) {
    outcome = { kind: "route-only-removal", removed: [], routedDocumentRemoved: true, remaining };
  } else if (removed.length === 0) {
    outcome = {
      kind: "exact-route-cleanup",
      removed: [],
      deskActiveRemoved: false,
      routedDocumentRemoved: false,
      remaining,
    };
  } else if (!deskActiveRemoved && !routedDocumentRemoved) {
    outcome = {
      kind: "inactive-removal",
      removed,
      deskActiveRemoved: false,
      routedDocumentRemoved: false,
      remaining,
    };
  } else if (remaining.length === 0) {
    outcome = {
      kind: "empty-desk",
      removed,
      deskActiveRemoved,
      routedDocumentRemoved,
      remaining: [],
    };
  } else {
    outcome = {
      kind: "active-fallback",
      removed,
      deskActiveRemoved,
      routedDocumentRemoved,
      fallback: selectedFallback ?? (remaining[0] as ContextTab),
      remaining,
    };
  }

  return {
    outcome,
    nextActiveTabId,
    admitted: input.admitted && !admittedWasRemoved ? input.admitted : admittedFallback,
    routeRepairTarget,
    workingSet: {
      removedLocators,
      survivingOwnedLocators,
      promote,
      // Exact locator removal is sufficient. A broad clear would erase unrelated
      // account-owned continuity that is intentionally not represented in this desk.
      clearAll: false,
    },
  };
}

function sameTarget(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return a.scheme === b.scheme && a.path === b.path && a.workId === b.workId;
}

function workingSetRouteMatchesTarget(route: WorkingSetRoute, target: ContextRouteTarget): boolean {
  return (
    route.scheme === target.scheme &&
    route.path === target.path &&
    (!isWorkScopedProjectContextScheme(route.scheme) || (route.workId ?? null) === target.workId)
  );
}

function workingSetRouteForTarget(locator: ContextRouteTarget): WorkingSetRoute | null {
  if (locator.scheme === "scratch" || locator.scheme === "uploads") {
    return locator.workId
      ? { scheme: locator.scheme, path: locator.path, workId: locator.workId }
      : null;
  }
  return { scheme: locator.scheme, path: locator.path };
}

export function chooseAdmittedFallback(input: {
  activeWorkId: string | null;
  tabs: readonly ContextTab[];
  activeTabId: string | null;
  admitted: ContextRouteTarget | null;
  recentRoutes: readonly WorkingSetRoute[];
  excluded: ContextRouteTarget | null;
}): ContextRouteTarget | null {
  const eligible = (target: ContextRouteTarget | null): target is ContextRouteTarget =>
    target !== null &&
    (!isWorkScopedProjectContextScheme(target.scheme) || target.workId === input.activeWorkId) &&
    (!input.excluded || !sameContinuityLocator(target, input.excluded));
  const activeTab =
    input.tabs.find(
      (tab) => tab.documentId === input.activeTabId && (tab.kind === "new" || !tab.draftOnly),
    ) ?? null;
  const activeTarget = activeTab ? routeTargetForTab(activeTab, input.activeWorkId) : null;
  if (eligible(activeTarget)) return activeTarget;
  if (eligible(input.admitted))
    return contextualizeProjectRoute(input.admitted, input.activeWorkId);
  for (const route of input.recentRoutes) {
    const target = contextualizeWorkingSetRoute(route, input.activeWorkId);
    if (eligible(target)) return target;
  }
  for (const tab of input.tabs) {
    if (tab.kind !== "new" && tab.draftOnly) continue;
    const target = routeTargetForTab(tab, input.activeWorkId);
    if (eligible(target)) return target;
  }
  return null;
}

function contextualizeWorkingSetRoute(
  route: WorkingSetRoute,
  activeWorkId: string | null,
): ContextRouteTarget {
  return {
    scheme: route.scheme,
    path: route.path,
    workId: isWorkScopedProjectContextScheme(route.scheme) ? (route.workId ?? null) : activeWorkId,
  };
}

function contextualizeProjectRoute(
  route: ContextRouteTarget,
  activeWorkId: string | null,
): ContextRouteTarget {
  return isWorkScopedProjectContextScheme(route.scheme)
    ? route
    : { ...route, workId: activeWorkId };
}

function sameContinuityLocator(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return (
    a.scheme === b.scheme &&
    a.path === b.path &&
    (!isWorkScopedProjectContextScheme(a.scheme) || a.workId === b.workId)
  );
}
