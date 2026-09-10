/** Pure selection and represented-removal obligation protocol. */

import type { ContextTab } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";
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

export function sameLocator(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return a.scheme === b.scheme && a.path === b.path && a.workId === b.workId;
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
): SelectionTransition | null {
  if (selection.revision !== revision) return null;
  if (selection.status === "candidate") {
    const bound: Extract<ContextRouteSelection, { status: "bound" }> = {
      status: "bound",
      revision,
      locator: selection.locator,
      identity,
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
      return { selection, planning: [], rejection: null, retireReentryGuard: false };
    }
    return {
      selection: { ...selection, revision: revision + 1, identity },
      planning: [],
      rejection: null,
      retireReentryGuard: false,
    };
  }
  if (selection.status === "rejected") {
    return {
      selection: { status: "bound", revision: revision + 1, locator: selection.locator, identity },
      planning: [],
      rejection: null,
      retireReentryGuard: false,
    };
  }
  return null;
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
        return selection.locator.scheme === "scratch" && selection.locator.path === "";
      }
      return contextTabMatchesRoute(
        tab,
        selection.locator.scheme,
        selection.locator.path,
        selection.locator.workId,
      );
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
  if (!represented) {
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
  const locator = routeTargetForTab(
    represented,
    selection.status === "none" ? null : selection.locator.workId,
  );
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
  let repair: "allow" | "never" = selection.status === "none" ? "never" : "allow";
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
  } else if (selection.status !== "none" && !sameLocator(selection.locator, locator)) {
    repair = "never";
  }
  return { selection: nextSelection, planning: { intent, cleanup, current, repair } };
}
