/** Pure eligibility and continuity planning for one exact context-removal intent. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { buildWorkingSetRoute, type ReconcileContextRoutesInput } from "@/client/working-set";
import type { ContextRouteTarget } from "../routing/project-route";

export type ContextRemovalIntent = {
  cause: "writer-close" | "acknowledged-delete" | "work-prune" | "draft-discard";
  documentIds: readonly string[];
};

export type ContextRouteIdentity = { kind: "server" | "local"; documentId: string };

export type RouteContinuityVerdict =
  | { kind: "none" }
  | {
      kind: "preserved-unknown";
      revision: number;
      locator: ContextRouteTarget;
      observed: "pending" | "confirmed-unbound" | "superseded";
    }
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
  rememberedRoute: ContextRouteTarget | null;
  routeRepairTarget: ContextRouteTarget | { kind: "clear" } | null;
  workingSet: ReconcileContextRoutesInput;
};

export type ContextRemovalPlannerInput = {
  tabs: readonly ContextTab[];
  activeTabId: string | null;
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

  const continuity =
    boundSelection ??
    provenRemoved ??
    (input.route.current.kind === "preserved-unknown" ? input.route.current : null);
  const boundRoute = continuity
    ? buildWorkingSetRoute(
        continuity.locator.scheme,
        continuity.locator.path,
        continuity.locator.workId,
      )
    : null;
  const survivingBoundRoute = continuity && !routedDocumentRemoved ? boundRoute : null;

  if (removed.length === 0 && !routedDocumentRemoved && !exactCleanup) {
    return {
      outcome: { kind: "noop" },
      nextActiveTabId: input.activeTabId,
      rememberedRoute: continuity ? continuity.locator : null,
      routeRepairTarget: null,
      workingSet: {
        removedLocators: [],
        survivingOwnedLocators: [
          ...input.tabs.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
          ...(survivingBoundRoute ? [survivingBoundRoute] : []),
        ],
        promote: survivingBoundRoute,
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
  const removedLocators = removed.flatMap((tab) => workingSetRouteForTab(tab) ?? []);
  const cleanup = input.route.cleanup;
  if (cleanup && exactCleanup) {
    const cleanupRoute = workingSetRouteForTarget(cleanup.locator);
    if (cleanupRoute) removedLocators.push(cleanupRoute);
  }
  const survivingOwnedLocators = [
    ...remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []),
    ...(survivingBoundRoute ? [survivingBoundRoute] : []),
  ];
  const promotedTab = survivingRoutedTab ?? fallback;
  const promote = survivingBoundRoute ?? (promotedTab ? workingSetRouteForTab(promotedTab) : null);
  const routeRepairTarget = routedDocumentRemoved
    ? fallback
      ? routeTargetForTab(fallback, continuity?.locator.workId ?? null)
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
    rememberedRoute:
      continuity && !routedDocumentRemoved
        ? continuity.locator
        : promotedTab
          ? routeTargetForTab(promotedTab, continuity?.locator.workId ?? null)
          : null,
    routeRepairTarget,
    workingSet: {
      removedLocators,
      survivingOwnedLocators,
      promote,
      clearAll: remaining.length === 0 && survivingBoundRoute === null,
    },
  };
}

function workingSetRouteForTarget(locator: ContextRouteTarget): WorkingSetRoute | null {
  if (locator.scheme === "scratch" || locator.scheme === "uploads") {
    return locator.workId
      ? { scheme: locator.scheme, path: locator.path, workId: locator.workId }
      : null;
  }
  return { scheme: locator.scheme, path: locator.path };
}
