/** Derives and transports one explicit writer request for a document's final identity. */

import { t } from "@lingui/core/macro";
import { type ProjectContextTreeScheme, storedFilename } from "@meridian/contracts/protocol";
import { moveDocumentAcrossLists } from "@/client/api/projects-api";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import { type OpenDocument, type OpenDocumentOwner, replaceOwner } from "@/client/stores";
import { parseContextUri } from "@/lib/context-uri";
import type { OpenContextOptions } from "../routing/ProjectNavigationContext";
import { type ContextRouteRequest, contextRouteRequest } from "../routing/project-route";
import { documentRow } from "./context-entry-name";
import { type DesiredIdentity, identityDestination, tabLocation } from "./identity-location";

const EDITOR_SCHEMES = ["manuscript", "kb", "user", "unfiled", "scratch"] as const;

export type IdentityCommitTarget = DesiredIdentity;
export type { DesiredIdentity, IdentityDestination } from "./identity-location";

export type IdentityCommitOutcome = { status: "committed" } | { status: "error"; message: string };

/** Every commit through this seam is an explicit writer save, so provisional naming ends. */
export type IdentityCommitted = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style path with a leading slash. */
  path: string;
  name: string;
} & OpenDocumentOwner;

export type IdentityCommitOwnership = {
  /** Always true: a commit appends its records before it returns, so none is superseded. */
  isLatest: boolean;
  /** The mounted representation captured before the namespace command. */
  document: OpenDocument;
};

export function identityCommitMayNavigate(
  ownership: IdentityCommitOwnership,
  activeDocumentId: string | null | undefined,
  committedDocumentId: string,
): boolean {
  return ownership.isLatest && activeDocumentId === committedDocumentId;
}

/**
 * The route command that follows a committed rename or move of the document the
 * address names. The address stays on that document, so it repairs in place: no
 * history entry, and the review it carries survives.
 */
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
  // Compare the name the server will store (`Chapter 13.md` is `Chapter 13`).
  const stored = storedFilename(
    target.name,
    tab.kind === "new" ? undefined : documentRow(location.leaf),
  );
  const desired = {
    destination: identityDestination(location, editorWorkId, target.destination),
    name: stored.ok ? stored.name : target.name.trim(),
    ...(target.typedName ? { typedName: target.typedName } : {}),
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
  });
  return async (target) => {
    const plan = deriveIdentityCommitPlan(document, target, editorWorkId);
    if (plan.kind === "no-op") return { status: "committed" };

    try {
      const destination = plan.desired.destination;
      const current = location.scheme;
      const folder = destination.folderPath.split("/").filter(Boolean).join("/");
      // A move between a project and the account's files spans two lists: a server route, not a record.
      if ((destination.scheme === "user") !== (current === "user")) {
        const from = trees[current as (typeof EDITOR_SCHEMES)[number]].tree;
        const into = trees[destination.scheme as (typeof EDITOR_SCHEMES)[number]].tree;
        const file = from?.findDocument(document.documentId);
        if (!from || !into || !file) throw new Error("Document is not in the list");
        const parent =
          destination.parentId ??
          (folder ? into.findPath(`/${folder}`)?.entryId : into.root.entryId);
        const to = parent && (parent === into.root.entryId ? into.root : into.entry(parent));
        if (!to) throw new Error("Destination folder is unavailable");
        const answer = await moveDocumentAcrossLists(projectId, {
          nodeId: file.entryId,
          from: from.root.uri,
          to: to.uri,
          ...(plan.desired.name !== file.name ? { name: plan.desired.name } : {}),
        });
        const placed = parseContextUri(answer.uri);
        if (!placed) throw new Error("The move's answer names no place");
        onCommitted(
          document.documentId,
          {
            scheme: destination.scheme,
            path: placed.path.startsWith("/") ? placed.path : `/${placed.path}`,
            name: plan.desired.name,
            ...replaceOwner(destination),
          },
          { isLatest: true, document },
        );
        return { status: "committed" };
      }
      const actions = destination.scheme === "user" ? accountActions : projectActions;
      const from = trees[current as (typeof EDITOR_SCHEMES)[number]].tree;
      const into = trees[destination.scheme as (typeof EDITOR_SCHEMES)[number]].tree;
      const file = from?.findDocument(document.documentId);
      if (!from || !into || !file) throw new Error("Document is not in the list");
      const parentId =
        destination.parentId ?? (folder ? into.findPath(`/${folder}`)?.entryId : into.root.entryId);
      if (!parentId) throw new Error("Destination folder is unavailable");

      const moved = parentId !== file.parentId;
      const asked = moved ? actions.move(file.entryId, parentId) : { ok: true as const };
      if (!asked.ok) throw new Error(asked.reason);
      const stored = storedFilename(plan.desired.name, file);
      const renamed =
        plan.desired.name !== file.name || file.provisionalName
          ? actions.rename(
              file.entryId,
              plan.desired.name,
              (stored.ok ? stored.filename.filetype : null) ?? undefined,
            )
          : { ok: true as const, name: file.name };
      if (!renamed.ok) throw new Error(renamed.reason);
      onCommitted(
        document.documentId,
        {
          scheme: destination.scheme,
          path: `/${[folder, renamed.name].filter(Boolean).join("/")}`,
          name: renamed.name,
          ...replaceOwner(destination),
        },
        { isLatest: true, document },
      );
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home. Try again.` };
    }
  };
}
