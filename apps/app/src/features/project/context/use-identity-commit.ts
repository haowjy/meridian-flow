/** Derives and transports one explicit writer request for a document's final identity. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { moveContextEntry, renameContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextTab } from "@/client/stores";
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

type IdentityCommitPlan =
  | { kind: "queue"; desired: DesiredIdentity }
  | { kind: "no-op" }
  | { kind: "rename"; desired: DesiredIdentity }
  | { kind: "move" | "graduate"; desired: DesiredIdentity };

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}

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
    return location.provisional ? { kind: "graduate", desired } : { kind: "no-op" };
  }
  return sameDestination ? { kind: "rename", desired } : { kind: "move", desired };
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
  onCommitted: (documentId: string, next: IdentityCommitted) => void;
}): (target: DesiredIdentity) => Promise<IdentityCommitOutcome> {
  const queryClient = useQueryClient();

  return async (target) => {
    const plan = deriveIdentityCommitPlan(tab, target, defaultWorkId);
    if (plan.kind === "queue") {
      queueUntitledIdentity(tab.documentId, plan.desired);
      return { status: "committed" };
    }
    if (plan.kind === "no-op") return { status: "committed" };
    if (tab.kind === "new") return { status: "committed" };

    try {
      if (plan.kind === "rename") {
        const result = await renameContextEntry(
          projectId,
          tab.scheme,
          { path: tab.path, newName: plan.desired.name },
          tab.workId ? { workId: tab.workId } : undefined,
        );
        if (result.status === "conflict") {
          return {
            status: "conflict",
            locator: {
              scheme: tab.scheme,
              path: replaceBasename(tab.path, plan.desired.name),
              ...(tab.workId ? { workId: tab.workId } : {}),
            },
          };
        }
        await queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextTree(projectId, tab.scheme, tab.workId),
        });
        onCommitted(tab.documentId, {
          scheme: tab.scheme,
          path: replaceBasename(tab.path, plan.desired.name),
          name: plan.desired.name,
          ...(tab.workId ? { workId: tab.workId } : {}),
        });
        return { status: "committed" };
      }

      const destination = plan.desired.destination;
      const moved = await moveContextEntry(projectId, tab.scheme, {
        path: stripLeadingSlash(tab.path),
        ...(tab.workId ? { sourceWorkId: tab.workId } : {}),
        destinationScheme: destination.scheme,
        destinationFolderPath: stripLeadingSlash(
          destination.folderPath === "/" ? "" : destination.folderPath,
        ),
        ...(destination.workId ? { destinationWorkId: destination.workId } : {}),
        ...(plan.desired.name !== tab.name ? { newName: plan.desired.name } : {}),
      });
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
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextTree(projectId, tab.scheme, tab.workId),
        }),
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextTree(projectId, moved.scheme, destination.workId),
        }),
      ]);
      onCommitted(tab.documentId, {
        scheme: moved.scheme,
        path: `/${moved.path}`,
        name: moved.name,
        ...(destination.workId ? { workId: destination.workId } : {}),
      });
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home. Try again.` };
    }
  };
}
