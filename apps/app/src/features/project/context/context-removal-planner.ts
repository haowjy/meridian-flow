/** Pure eligibility and continuity planning for one exact context-removal intent. */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import {
  buildWorkingSetRoute,
  type ReconcileContextRoutesInput,
  workingSetRouteEquals,
} from "@/client/working-set";
import {
  type ContextRouteRequest,
  contextRouteRequest,
  sameContextTarget,
} from "../routing/project-route";

export type ContextRemovalIntent = {
  cause: "writer-close" | "catalog-unavailable" | "authority-unavailable" | "draft-discard";
  documentIds: readonly string[];
  /** Documents a draft keeps on screen when live loses them: their views keep them. */
  held?: ReadonlySet<string>;
};

export type ContextRouteIdentity = { kind: "server" | "local"; documentId: string };

export type RouteContinuityVerdict =
  | { kind: "none" }
  | {
      kind: "bound";
      revision: number;
      locator: ContextRouteRequest;
      identity: ContextRouteIdentity;
    }
  | {
      kind: "proven-removed";
      revision: number;
      locator: ContextRouteRequest;
      identity: ContextRouteIdentity;
    };

export type ContextRemovalOutcome =
  | { kind: "noop" }
  | {
      kind: "removal";
      removed: readonly OpenDocument[];
      workspaceSelectedRemoved: boolean;
      routedDocumentRemoved: boolean;
      remaining: readonly OpenDocument[];
    };

export type ContextRemovalPlan = {
  outcome: ContextRemovalOutcome;
  admitted: ContextRouteRequest | null;
  workingSet: ReconcileContextRoutesInput;
};

export type ContextRemovalPlannerInput = {
  activeWorkId: string | null;
  tabs: readonly OpenDocument[];
  selectedTabId: string | null;
  admitted: ContextRouteRequest | null;
  route: {
    cleanup: ExactRouteCleanup | null;
    current: RouteContinuityVerdict;
  };
  intent: ContextRemovalIntent;
};

export type ExactRouteCleanup = {
  revision: number;
  locator: ContextRouteRequest;
  identity: ContextRouteIdentity;
};

/** A rejected candidate leaves the address as written: the view says the document is gone. */
export function planCandidateRejection(input: {
  rejected: ContextRouteRequest;
  tabs: readonly OpenDocument[];
  admitted: ContextRouteRequest | null;
  recentRoutes: readonly WorkingSetRoute[];
}): { admitted: ContextRouteRequest | null; workingSet: ReconcileContextRoutesInput } {
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

export function openDocumentEligibleForRemoval(
  tab: OpenDocument,
  intent: ContextRemovalIntent,
): boolean {
  if (!intent.documentIds.includes(tab.documentId)) return false;
  switch (intent.cause) {
    case "writer-close":
      return true;
    case "catalog-unavailable":
    case "authority-unavailable":
      return tab.kind !== "new" && !intent.held?.has(tab.documentId);
    case "draft-discard":
      return tab.kind !== "new";
  }
}

export function workingSetRouteForTab(tab: OpenDocument) {
  // A route names a document the server holds: it answers the whole snapshot with a 400 when
  // one is missing, so a local-only document's route waits for its materialization.
  if (tab.kind === "new" || (tab.kind === "tracked" && tab.localOnly)) return null;
  return buildWorkingSetRoute(tab.documentId, tab.scheme, tab.path, tab);
}

export function routeTargetForTab(tab: OpenDocument): ContextRouteRequest {
  if (tab.kind === "new") return { scheme: "unfiled", path: "", documentId: tab.documentId };
  if (isWorkScopedScheme(tab.scheme) && !tab.rootThreadId && !tab.workId)
    throw new Error("Work-scoped tab has no Work owner");
  return contextRouteRequest(tab);
}

/** The tab a target names: by its document when it carries one, else by locator. */
export function documentForTarget(
  tabs: readonly OpenDocument[],
  target: ContextRouteRequest,
): OpenDocument | null {
  return (
    tabs.find((tab) =>
      target.documentId !== undefined
        ? tab.documentId === target.documentId
        : sameContextTarget(routeTargetForTab(tab), target),
    ) ?? null
  );
}

/** Query/cache state is deliberately absent: exact commands are the only removal evidence. */
export function planContextRemoval(input: ContextRemovalPlannerInput): ContextRemovalPlan {
  const requested = new Set(input.intent.documentIds);
  const removed = input.tabs.filter((tab) => openDocumentEligibleForRemoval(tab, input.intent));
  const removedIds = new Set(removed.map((tab) => tab.documentId));
  const remaining = input.tabs.filter((tab) => !removedIds.has(tab.documentId));
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
  const visibleRemaining = remaining.filter(isEditorOpenDocument);
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
    ? documentForTarget(
        input.tabs,
        boundSelection && sameContextTarget(boundSelection.locator, admitted)
          ? { ...admitted, documentId: boundSelection.identity.documentId }
          : admitted,
      )
    : null;
  const admittedRoute = admittedTab
    ? workingSetRouteForTab(admittedTab)
    : input.admitted && boundSelection && sameContextTarget(boundSelection.locator, input.admitted)
      ? workingSetRouteForTarget(boundSelection.identity.documentId, input.admitted)
      : null;
  const survivingRoutes = remaining.flatMap((tab) => workingSetRouteForTab(tab) ?? []);
  const removedTabRoutes = removed
    .flatMap((tab) => workingSetRouteForTab(tab) ?? [])
    .filter((route) => !survivingRoutes.some((survivor) => workingSetRouteEquals(survivor, route)));
  const admittedWasRemoved =
    input.admitted !== null &&
    ((provenRemoved !== null && sameContextTarget(provenRemoved.locator, input.admitted)) ||
      (input.route.cleanup !== null &&
        sameContextTarget(input.route.cleanup.locator, input.admitted) &&
        !(
          boundSelection !== null &&
          sameContextTarget(boundSelection.locator, input.admitted) &&
          boundSelection.identity.documentId !== input.route.cleanup.identity.documentId
        )) ||
      removedTabRoutes.some((route) =>
        workingSetRouteMatchesTarget(route, input.admitted as ContextRouteRequest),
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
  const survivingRoutedTarget = survivingRoutedTab ? routeTargetForTab(survivingRoutedTab) : null;
  const survivingRoutedIsUnadmittedBinding =
    survivingRoutedTarget !== null &&
    boundSelection !== null &&
    sameContextTarget(survivingRoutedTarget, boundSelection.locator) &&
    (input.admitted === null || !sameContextTarget(input.admitted, boundSelection.locator));
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

function workingSetRouteMatchesTarget(
  route: WorkingSetRoute,
  target: ContextRouteRequest,
): boolean {
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
  locator: ContextRouteRequest,
): WorkingSetRoute | null {
  return buildWorkingSetRoute(documentId, locator.scheme, locator.path, locator);
}

function sameContinuityLocator(a: ContextRouteRequest, b: ContextRouteRequest): boolean {
  return (
    a.scheme === b.scheme &&
    a.path === b.path &&
    a.rootThreadId === b.rootThreadId &&
    (!isWorkScopedScheme(a.scheme) || a.rootThreadId !== undefined || a.workId === b.workId)
  );
}
