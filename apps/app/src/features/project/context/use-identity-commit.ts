/** Derives and transports one explicit writer request for a document's final identity. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ResourceWorkAuthority, resourceWorkAuthorityFor } from "@meridian/resource-replica";
import { useWorks } from "@/client/query/useWorks";
import type { ContextTab } from "@/client/stores";
import { useAccountResourceReplica } from "./account-feature-context";
import {
  type DesiredIdentity,
  type IdentityDestination,
  identityDestination,
  tabLocation,
} from "./identity-location";

export type IdentityCommitTarget = DesiredIdentity;
export type { DesiredIdentity, IdentityDestination } from "./identity-location";

export type IdentityCommitOutcome = { status: "committed" } | { status: "error"; message: string };

/** Every commit through this seam is an explicit writer save, so provisional naming ends. */
export type IdentityCommitted = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style path with a leading slash. */
  path: string;
  name: string;
  workId?: string;
  /** Editor route ownership captured when this command began. */
  routeWorkId: string | null;
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
  editorWorkId: string | null,
): IdentityCommitPlan {
  const location = tabLocation(tab);
  const desired = {
    destination: identityDestination(location, editorWorkId, target.destination),
    name: target.name.trim(),
  };
  if (tab.kind === "new") return { kind: "queue", desired };

  const current = identityDestination(location, editorWorkId);
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

/** Resolve a placement from the project snapshot; unavailable identity fails on the document. */
function identityWorkAuthority(
  destination: IdentityDestination,
  works: readonly { id: string; slug: string | null }[] | null | undefined,
  noWork: { id: string } | null | undefined,
): ResourceWorkAuthority | null {
  if (destination.scheme !== "scratch" && !destination.workId) return { workId: null };
  const workId = destination.workId ?? noWork?.id;
  if (!workId) return null;
  return resourceWorkAuthorityFor(workId, works, noWork?.id);
}

export function useIdentityCommit({
  projectId,
  tab,
  editorWorkId,
  onCommitted,
}: {
  projectId: string;
  tab: ContextTab;
  editorWorkId: string | null;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
}): (target: DesiredIdentity) => Promise<IdentityCommitOutcome> {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  return async (target) => {
    const plan = deriveIdentityCommitPlan(tab, target, editorWorkId);
    if (plan.kind === "no-op") return { status: "committed" };

    try {
      const key = tab.resourceHandle
        ? { handle: tab.resourceHandle }
        : await resources.keyForDocument(projectId, tab.documentId);
      if (!key) throw new Error("Document resource is unavailable");
      const destination = plan.desired.destination;
      const authority = identityWorkAuthority(destination, works, noWork);
      if (!authority) throw new Error("The destination Work is unavailable");
      const ownership = await resources.setLocation(projectId, key, {
        scheme: destination.scheme,
        folderPath: destination.folderPath,
        name: plan.desired.name,
        ...authority,
      });
      const folder = destination.folderPath.split("/").filter(Boolean).join("/");
      onCommitted(
        tab.documentId,
        {
          scheme: destination.scheme,
          path: `/${[folder, plan.desired.name].filter(Boolean).join("/")}`,
          name: plan.desired.name,
          ...(destination.workId ? { workId: destination.workId } : {}),
          routeWorkId: authority.workId ?? editorWorkId,
        },
        ownership,
      );
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home. Try again.` };
    }
  };
}
