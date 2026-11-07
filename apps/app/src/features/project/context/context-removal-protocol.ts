/** Pure selection and represented-removal obligation protocol. */

import type { ContextTab } from "@/client/stores";
import { canonicalDocumentPath } from "../routing/local-document-address";
import { type ContextRouteTarget, sameContextTarget } from "../routing/project-route";
import {
  type ContextRemovalIntent,
  type ContextRouteIdentity,
  contextTabEligibleForRemoval,
  type ExactRouteCleanup,
  type RouteContinuityVerdict,
  routeTargetForTab,
} from "./context-removal-planner";
import { contextTabMatchesRoute } from "./context-tab-identity";

export type RouteRemovalProof = {
  locator: ContextRouteTarget;
  identity: ContextRouteIdentity;
  witnessedRevision: number;
  intent: ContextRemovalIntent;
};

export type PendingRouteObligation = {
  selectionRevision: number;
  proof: RouteRemovalProof;
};

export type TerminalRouteRemoval = {
  cleanup: ExactRouteCleanup;
  intent: ContextRemovalIntent;
};

/**
 * What proved a bound route's document. A navigation that named it and an address answer prove it
 * for the locator; a review proves it only for the address that carries its item.
 */
export type RouteBindingProof = "navigation" | "answer" | "review";

export type ContextRouteSelection =
  | { status: "none"; revision: number }
  | {
      status: "candidate";
      revision: number;
      locator: ContextRouteTarget;
      obligations: readonly PendingRouteObligation[];
      reentryGuard: TerminalRouteRemoval | null;
    }
  | {
      status: "bound";
      revision: number;
      locator: ContextRouteTarget;
      identity: ContextRouteIdentity;
      by: RouteBindingProof;
    }
  | {
      status: "rejected";
      revision: number;
      locator: ContextRouteTarget;
      reason: "fulfilled-absence" | "missing-local-owner";
    };

export type RemovalPlanningEffect = {
  intent: ContextRemovalIntent;
  cleanup: ExactRouteCleanup | null;
  current: RouteContinuityVerdict;
  repair: "allow" | "never";
};

export type SelectionTransition = {
  selection: ContextRouteSelection;
  planning: readonly RemovalPlanningEffect[];
  rejection: Extract<ContextRouteSelection, { status: "rejected" }> | null;
  retireReentryGuard: boolean;
};

export const sameLocator = sameContextTarget;

export type RouteOwner = Pick<ContextRouteTarget, "scheme" | "path" | "workId" | "rootThreadId">;

/** Whether the selection is about exactly this route (paths compare without the leading slash). */
export function selectionAtRoute(
  selection: ContextRouteSelection,
  route: RouteOwner,
): selection is Exclude<ContextRouteSelection, { status: "none" }> {
  if (selection.status === "none") return false;
  const { locator } = selection;
  return (
    locator.scheme === route.scheme &&
    canonicalDocumentPath(locator.path) === canonicalDocumentPath(route.path) &&
    locator.workId === route.workId &&
    locator.rootThreadId === route.rootThreadId
  );
}

/** The document the route is bound to: proven by a navigation that named it or by an address answer. */
export function routeSelectionDocumentId(
  selection: ContextRouteSelection,
  route: RouteOwner,
): string | null {
  return selectionAtRoute(selection, route) &&
    selection.status === "bound" &&
    selection.identity.kind === "server"
    ? selection.identity.documentId
    : null;
}

export function continuityForSelection(selection: ContextRouteSelection): RouteContinuityVerdict {
  return selection.status === "bound"
    ? {
        kind: "bound",
        revision: selection.revision,
        locator: selection.locator,
        identity: selection.identity,
      }
    : { kind: "none" };
}

function cleanupForProof(proof: RouteRemovalProof): ExactRouteCleanup {
  return {
    revision: proof.witnessedRevision,
    locator: proof.locator,
    identity: proof.identity,
  };
}

function settleObligations(
  selection: Extract<ContextRouteSelection, { status: "candidate" }>,
  observed: ContextRouteIdentity | null,
  current: RouteContinuityVerdict,
  repair: "allow" | "never",
): RemovalPlanningEffect[] {
  return selection.obligations.map(({ proof }) => ({
    intent: proof.intent,
    cleanup: cleanupForProof(proof),
    current:
      (observed === null && repair === "allow") ||
      observed?.documentId === proof.identity.documentId
        ? {
            kind: "proven-removed",
            revision: selection.revision,
            locator: selection.locator,
            identity: observed ?? proof.identity,
          }
        : current,
    repair,
  }));
}

export function beginSelection(
  selection: ContextRouteSelection,
  locator: ContextRouteTarget,
  reentryGuard: TerminalRouteRemoval | null = null,
): SelectionTransition {
  // A navigation that named its document, or an answer, already bound this locator. A review's
  // binding ends with its address: the same path without the item names no document.
  if (
    selection.status === "bound" &&
    selection.by !== "review" &&
    sameLocator(selection.locator, locator)
  )
    return { selection, planning: [], rejection: null, retireReentryGuard: false };
  const revision = selection.revision + 1;
  const next: ContextRouteSelection = {
    status: "candidate",
    revision,
    locator,
    obligations: [],
    reentryGuard,
  };
  if (selection.status !== "candidate") {
    return {
      selection: next,
      planning: [],
      rejection: null,
      retireReentryGuard: false,
    };
  }
  return {
    selection: next,
    planning: settleObligations(selection, null, { kind: "none" }, "never"),
    rejection: null,
    retireReentryGuard: false,
  };
}

/** Supersedes old-Work continuity without ever offering it for promotion. */
export function supersedeSelectionForWorkChange(
  selection: ContextRouteSelection,
  locator: ContextRouteTarget | null,
  reentryGuard: TerminalRouteRemoval | null = null,
): SelectionTransition {
  if (selection.status === "bound" && locator && sameLocator(selection.locator, locator))
    return { selection, planning: [], rejection: null, retireReentryGuard: false };
  const revision = selection.revision + 1;
  const next: ContextRouteSelection = locator
    ? { status: "candidate", revision, locator, obligations: [], reentryGuard }
    : { status: "none", revision };
  return {
    selection: next,
    planning:
      selection.status === "candidate"
        ? settleObligations(selection, null, { kind: "none" }, "never")
        : [],
    rejection: null,
    retireReentryGuard: false,
  };
}

export function bindSelection(
  selection: ContextRouteSelection,
  revision: number,
  identity: ContextRouteIdentity,
  by: RouteBindingProof,
): SelectionTransition | null {
  if (selection.revision !== revision) return null;
  if (selection.status === "candidate") {
    const bound: Extract<ContextRouteSelection, { status: "bound" }> = {
      status: "bound",
      revision,
      locator: selection.locator,
      identity,
      by,
    };
    const current = continuityForSelection(bound);
    const guard = selection.reentryGuard;
    const guardMatches = guard?.cleanup.identity.documentId === identity.documentId;
    return {
      selection: bound,
      planning: [
        ...settleObligations(selection, identity, current, "allow"),
        ...(guardMatches && guard
          ? [
              {
                intent: guard.intent,
                cleanup: guard.cleanup,
                current: {
                  kind: "proven-removed" as const,
                  revision,
                  locator: selection.locator,
                  identity,
                },
                repair: "allow" as const,
              },
            ]
          : []),
      ],
      rejection: null,
      retireReentryGuard: Boolean(guard && !guardMatches),
    };
  }
  if (selection.status === "bound") {
    if (
      selection.identity.kind === identity.kind &&
      selection.identity.documentId === identity.documentId
    ) {
      // A review address is the review's own: another binder that got there first yields to it,
      // and a plain proof never takes it back.
      if (by === "review" && selection.by !== "review")
        return {
          selection: { ...selection, revision: revision + 1, by },
          planning: [],
          rejection: null,
          retireReentryGuard: false,
        };
      return { selection, planning: [], rejection: null, retireReentryGuard: false };
    }
    return {
      selection: { ...selection, revision: revision + 1, identity, by },
      planning: [],
      rejection: null,
      retireReentryGuard: false,
    };
  }
  if (selection.status === "rejected") {
    return {
      selection: {
        status: "bound",
        revision: revision + 1,
        locator: selection.locator,
        identity,
        by,
      },
      planning: [],
      rejection: null,
      retireReentryGuard: false,
    };
  }
  return null;
}

/** A writer's exit from a review, or its close, keeps the document the route is bound to. */
export function adoptReviewBinding(selection: ContextRouteSelection): SelectionTransition | null {
  if (selection.status !== "bound" || selection.by !== "review") return null;
  return {
    selection: { ...selection, by: "navigation" },
    planning: [],
    rejection: null,
    retireReentryGuard: false,
  };
}

export function rejectSelection(
  selection: ContextRouteSelection,
  revision: number,
  reason: "fulfilled-absence" | "missing-local-owner" = "fulfilled-absence",
): SelectionTransition | null {
  if (selection.status !== "candidate" || selection.revision !== revision) return null;
  const next: ContextRouteSelection = {
    status: "rejected",
    revision,
    locator: selection.locator,
    reason,
  };
  const guard = selection.reentryGuard;
  const current = guard
    ? ({
        kind: "proven-removed",
        revision,
        locator: selection.locator,
        identity: guard.cleanup.identity,
      } as const)
    : continuityForSelection(next);
  return {
    selection: next,
    planning: [
      ...settleObligations(selection, null, current, "allow"),
      ...(guard
        ? [{ intent: guard.intent, cleanup: guard.cleanup, current, repair: "allow" as const }]
        : []),
    ],
    rejection: guard || selection.obligations.length > 0 ? null : next,
    retireReentryGuard: false,
  };
}

export function leaveSelection(selection: ContextRouteSelection): SelectionTransition {
  const next: ContextRouteSelection = { status: "none", revision: selection.revision + 1 };
  if (selection.status !== "candidate") {
    return { selection: next, planning: [], rejection: null, retireReentryGuard: false };
  }
  return {
    selection: next,
    planning: settleObligations(selection, null, { kind: "none" }, "never"),
    rejection: null,
    retireReentryGuard: false,
  };
}

function representedTab(
  tabs: readonly ContextTab[],
  intent: ContextRemovalIntent,
  selection: ContextRouteSelection,
): ContextTab | null {
  if (selection.status === "none") {
    return tabs.find((tab) => contextTabEligibleForRemoval(tab, intent)) ?? null;
  }
  return (
    tabs.find((tab) => {
      if (!contextTabEligibleForRemoval(tab, intent)) return false;
      if (tab.kind === "new") {
        return selection.locator.scheme === "unfiled" && selection.locator.path === "";
      }
      return contextTabMatchesRoute(tab, selection.locator);
    }) ??
    tabs.find((tab) => contextTabEligibleForRemoval(tab, intent)) ??
    null
  );
}

export function reduceRepresentedRemoval(
  selection: ContextRouteSelection,
  tabs: readonly ContextTab[],
  intent: ContextRemovalIntent,
  exactBoundIdentity = false,
): { selection: ContextRouteSelection; planning: RemovalPlanningEffect } {
  const represented = representedTab(tabs, intent, selection);
  if (!represented || selection.status === "none") {
    if (
      exactBoundIdentity &&
      selection.status === "bound" &&
      selection.identity.kind === "server" &&
      intent.documentIds.includes(selection.identity.documentId)
    ) {
      const cleanup: ExactRouteCleanup = {
        revision: selection.revision,
        locator: selection.locator,
        identity: selection.identity,
      };
      return {
        selection,
        planning: {
          intent,
          cleanup,
          current: { kind: "proven-removed", ...cleanup },
          repair: "allow",
        },
      };
    }
    return {
      selection,
      planning: {
        intent,
        cleanup: null,
        current: continuityForSelection(selection),
        repair: "allow",
      },
    };
  }
  // A review removal addresses its own Work's route, not whichever Work is routed now.
  const locator = routeTargetForTab(represented, intent.reviewWorkId ?? selection.locator.workId);
  const identity: ContextRouteIdentity = {
    kind: represented.kind === "new" ? "local" : "server",
    documentId: represented.documentId,
  };
  const proof: RouteRemovalProof = {
    locator,
    identity,
    witnessedRevision: selection.revision,
    intent,
  };
  const cleanup = cleanupForProof(proof);
  let nextSelection = selection;
  let current = continuityForSelection(selection);
  let repair: "allow" | "never" = "allow";
  if (selection.status === "candidate" && sameLocator(selection.locator, locator)) {
    nextSelection = {
      ...selection,
      obligations: [...selection.obligations, { selectionRevision: selection.revision, proof }],
    };
    current = continuityForSelection(nextSelection);
  } else if (
    selection.status === "bound" &&
    sameLocator(selection.locator, locator) &&
    selection.identity.documentId === identity.documentId
  ) {
    current = { kind: "proven-removed", revision: selection.revision, locator, identity };
  } else if (selection.status === "rejected" && sameLocator(selection.locator, locator)) {
    current = { kind: "proven-removed", revision: selection.revision, locator, identity };
  } else if (!sameLocator(selection.locator, locator)) {
    repair = "never";
  }
  return { selection: nextSelection, planning: { intent, cleanup, current, repair } };
}
