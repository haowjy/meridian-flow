/** Derives and transports one explicit writer request for a document's final identity. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import { createContextIdentityMutationService } from "./context-identity-mutation";
import { type DesiredIdentity, identityDestination, tabLocation } from "./identity-location";
import { queueUntitledIdentity } from "./untitled-reconciler-browser";

export type IdentityCommitTarget = DesiredIdentity;
export type { DesiredIdentity, IdentityDestination } from "./identity-location";

export type IdentityCommitOutcome =
  | { status: "committed" }
  | {
      status: "conflict";
      locator: { scheme: ProjectContextTreeScheme; path: string; workId?: string };
    }
  | { status: "error"; message: string };

/** Every commit through this seam is an explicit writer save, so provisional naming ends. */
export type IdentityCommitted = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style path with a leading slash. */
  path: string;
  name: string;
  workId?: string;
};

export type IdentityCommitOwnership = {
  /** True only for the latest operation started by this identity surface. */
  isLatest: boolean;
};

export function identityCommitMayNavigate(
  ownership: IdentityCommitOwnership,
  activeDocumentId: string | null | undefined,
  committedDocumentId: string,
): boolean {
  return ownership.isLatest && activeDocumentId === committedDocumentId;
}

type IdentityCommitPlan =
  | { kind: "queue"; desired: DesiredIdentity }
  | { kind: "no-op" }
  | { kind: "commit"; desired: DesiredIdentity };

export function deriveIdentityCommitPlan(
  tab: ContextTab,
  target: DesiredIdentity,
  defaultWorkId: string | null,
): IdentityCommitPlan {
  const location = tabLocation(tab);
  const desired = {
    destination: identityDestination(location, defaultWorkId, target.destination),
    name: target.name.trim(),
  };
  if (tab.kind === "new") return { kind: "queue", desired };

  const current = identityDestination(location, defaultWorkId);
  const sameDestination =
    desired.destination.scheme === current.scheme &&
    desired.destination.folderPath === current.folderPath &&
    desired.destination.workId === current.workId;
  const sameName = desired.name === location.leaf;
  if (sameDestination && sameName) {
    return location.provisional ? { kind: "commit", desired } : { kind: "no-op" };
  }
  return { kind: "commit", desired };
}

export function useIdentityCommit({
  projectId,
  tab,
  defaultWorkId,
  onCommitted,
}: {
  projectId: string;
  tab: ContextTab;
  defaultWorkId: string | null;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
}): (target: DesiredIdentity) => Promise<IdentityCommitOutcome> {
  const queryClient = useQueryClient();
  const identityMutations = createContextIdentityMutationService(queryClient);
  return async (target) => {
    const plan = deriveIdentityCommitPlan(tab, target, defaultWorkId);
    if (plan.kind === "queue") {
      queueUntitledIdentity({ documentId: tab.documentId, projectId }, plan.desired);
      return { status: "committed" };
    }
    if (plan.kind === "no-op") return { status: "committed" };
    if (tab.kind === "new") return { status: "committed" };

    try {
      let activeDesired = plan.desired;
      let destination = activeDesired.destination;
      let moveReceipt = await identityMutations.move(
        tab.documentId,
        projectId,
        { scheme: tab.scheme, path: tab.path, ...(tab.workId ? { workId: tab.workId } : {}) },
        activeDesired,
      );
      let moved = moveReceipt.result;
      if (moved.status === "retry") {
        const freshTab = useContextTabsStore
          .getState()
          .byProject[projectId]?.tabs.find((candidate) => candidate.documentId === tab.documentId);
        if (!freshTab) {
          return {
            status: "error",
            message: t`This document changed elsewhere. Reopen it and try again.`,
          };
        }
        const freshPlan = deriveIdentityCommitPlan(freshTab, target, defaultWorkId);
        if (freshPlan.kind === "no-op") return { status: "committed" };
        if (freshPlan.kind !== "commit" || freshTab.kind === "new") {
          return {
            status: "error",
            message: t`This document changed elsewhere. Reopen it and try again.`,
          };
        }
        activeDesired = freshPlan.desired;
        destination = activeDesired.destination;
        moveReceipt = await identityMutations.move(
          tab.documentId,
          projectId,
          {
            scheme: freshTab.scheme,
            path: freshTab.path,
            ...(freshTab.workId ? { workId: freshTab.workId } : {}),
          },
          activeDesired,
        );
        moved = moveReceipt.result;
        if (moved.status === "retry") {
          return {
            status: "error",
            message: t`This document keeps changing elsewhere. Reopen it and try again.`,
          };
        }
      }
      if (moved.status === "conflict") {
        return {
          status: "conflict",
          locator: {
            scheme: moved.collision.scheme,
            path: `/${moved.collision.path}`,
            ...(moved.collision.workId ? { workId: moved.collision.workId } : {}),
          },
        };
      }
      onCommitted(
        tab.documentId,
        {
          scheme: moved.scheme,
          path: `/${moved.path}`,
          name: moved.name,
          ...(destination.workId ? { workId: destination.workId } : {}),
        },
        { isLatest: moveReceipt.isLatest },
      );
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home. Try again.` };
    }
  };
}
