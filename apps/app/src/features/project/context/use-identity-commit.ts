import { t } from "@lingui/core/macro";
import { type ProjectContextTreeScheme, storedFilename } from "@meridian/contracts/protocol";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import { type OpenDocument, type OpenDocumentOwner, replaceOwner } from "@/client/stores";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import type { OpenContextOptions } from "../routing/ProjectNavigationContext";
import { type ContextRouteRequest, contextRouteRequest } from "../routing/project-route";
import { documentRow } from "./context-entry-name";
import { type DesiredIdentity, identityDestination, tabLocation } from "./identity-location";

const EDITOR_SCHEMES = ["manuscript", "kb", "user", "unfiled", "agents", "scratch"] as const;

export type IdentityCommitTarget = DesiredIdentity;
export type { DesiredIdentity, IdentityDestination } from "./identity-location";

export type IdentityCommitOutcome = { status: "committed" } | { status: "error"; message: string };

export type IdentityCommitted = {
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
} & OpenDocumentOwner;

export type IdentityCommitOwnership = {
  isLatest: boolean;
  document: OpenDocument;
};

export function identityCommitMayNavigate(
  ownership: IdentityCommitOwnership,
  activeDocumentId: string | null | undefined,
  committedDocumentId: string,
): boolean {
  return ownership.isLatest && activeDocumentId === committedDocumentId;
}

export function identityCommitRoute(
  documentId: string,
  next: Pick<IdentityCommitted, "scheme" | "path" | "workId" | "rootThreadId">,
): { request: ContextRouteRequest; options: OpenContextOptions } {
  return {
    request: contextRouteRequest({ ...next, documentId }),
    options: { replace: true },
  };
}

type IdentityCommitPlan = { kind: "no-op" } | { kind: "commit"; desired: DesiredIdentity };

export function deriveIdentityCommitPlan(
  tab: OpenDocument,
  target: DesiredIdentity,
  editorWorkId: string | null,
): IdentityCommitPlan {
  const location = tabLocation(tab);
  const stored = storedFilename(
    target.name,
    tab.kind === "new" ? undefined : documentRow(location.leaf),
  );
  const desired = {
    destination: identityDestination(location, editorWorkId, target.destination),
    name: stored.ok ? stored.name : target.name.trim(),
  };

  const current = identityDestination(location, editorWorkId);
  const sameDestination =
    desired.destination.scheme === current.scheme &&
    desired.destination.folderPath === current.folderPath &&
    desired.destination.workId === current.workId &&
    desired.destination.rootThreadId === current.rootThreadId;
  const sameName = desired.name === location.leaf;
  if (sameDestination && sameName) {
    return location.provisional ? { kind: "commit", desired } : { kind: "no-op" };
  }
  return { kind: "commit", desired };
}

export function useIdentityCommit({
  projectId,
  document,
  editorWorkId,
  onCommitted,
}: {
  projectId: string;
  document: OpenDocument;
  editorWorkId: string | null;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
}): (target: DesiredIdentity) => Promise<IdentityCommitOutcome> {
  const projectActions = useTreeActions({ kind: "project", projectId });
  const accountActions = useTreeActions({ kind: "account" });
  const location = tabLocation(document);
  const trees = useProjectTreeViews(projectId, EDITOR_SCHEMES, {
    workId: location.workId ?? editorWorkId,
    rootThreadId: location.rootThreadId,
    version: useTreeVersion(),
  });
  return async (target) => {
    const plan = deriveIdentityCommitPlan(document, target, editorWorkId);
    if (plan.kind === "no-op") return { status: "committed" };

    try {
      const destination = plan.desired.destination;
      const current = location.scheme;
      const actions = destination.scheme === "user" ? accountActions : projectActions;
      const from = trees[current as (typeof EDITOR_SCHEMES)[number]].tree;
      const into = trees[destination.scheme as (typeof EDITOR_SCHEMES)[number]].tree;
      const file = from?.findDocument(document.documentId);
      if (!from || !into || !file) throw new Error("Document is not in the list");
      const parentId = destination.parentId ?? into.findFolder(destination.folderPath)?.entryId;
      if (!parentId) throw new Error("Destination folder is unavailable");

      const moved = parentId !== file.parentId;
      if (moved) actions.move(file.entryId, parentId);
      const stored = storedFilename(plan.desired.name, file);
      const renamed =
        plan.desired.name !== file.name || file.provisionalName
          ? actions.rename(
              file.entryId,
              plan.desired.name,
              (stored.ok ? stored.filename.filetype : null) ?? undefined,
            )
          : { name: file.name };
      const path = actions.pathOf(file.entryId);
      if (!path) throw new Error("Document is not in the list");
      onCommitted(
        document.documentId,
        {
          scheme: destination.scheme,
          path,
          name: renamed.name,
          ...replaceOwner(destination),
        },
        { isLatest: true, document },
      );
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home` };
    }
  };
}
