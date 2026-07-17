/**
 * The identity bar's single commit seam: rename in place, move (optionally
 * renaming), or queue a placement for a not-yet-materialized untitled doc.
 * Both typed surfaces (path field, placement field) and the Move-to popup
 * commit through here, so rename/move semantics cannot drift between them.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { moveContextEntry, renameContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextTab } from "@/client/stores";
import { queueUntitledPlacement, queueUntitledRename } from "./untitled-reconciler";

export type IdentityDestination = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/`, `/Act 2`. */
  folderPath: string;
};

export type IdentityCommitTarget = {
  /** Null commits a rename in place. */
  destination: IdentityDestination | null;
  name: string;
};

export type IdentityCommitOutcome =
  | { status: "committed" }
  | {
      status: "conflict";
      locator: { scheme: ProjectContextTreeScheme; path: string; workId?: string };
    }
  | { status: "error"; message: string };

/** Every commit through this seam is an explicit writer save, so the
 *  document graduates: provisional naming ends with it (D8). */
export type IdentityCommitted = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style path with a leading slash. */
  path: string;
  name: string;
  workId?: string;
};

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
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
}): (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome> {
  const queryClient = useQueryClient();

  return async (target) => {
    const name = target.name.trim();

    if (tab.kind === "new") {
      // Not yet materialized: the reconciler applies the intent after create;
      // failures land as receipts that reopen the field.
      if (target.destination) {
        queueUntitledPlacement(tab.documentId, name, {
          scheme: target.destination.scheme,
          folderPath: stripLeadingSlash(target.destination.folderPath),
          ...(isWorkScopedProjectContextScheme(target.destination.scheme) && defaultWorkId
            ? { workId: defaultWorkId }
            : {}),
        });
      } else {
        queueUntitledRename(tab.documentId, name);
      }
      return { status: "committed" };
    }

    const destination = target.destination;
    const destinationWorkId =
      destination && isWorkScopedProjectContextScheme(destination.scheme)
        ? ((tab.scheme === destination.scheme ? tab.workId : undefined) ??
          defaultWorkId ??
          undefined)
        : undefined;
    try {
      if (!destination) {
        if (name === tab.name) return { status: "committed" };
        const result = await renameContextEntry(
          projectId,
          tab.scheme,
          { path: tab.path, newName: name },
          tab.workId ? { workId: tab.workId } : undefined,
        );
        if (result.status === "conflict") {
          return {
            status: "conflict",
            locator: {
              scheme: tab.scheme,
              path: replaceBasename(tab.path, name),
              ...(tab.workId ? { workId: tab.workId } : {}),
            },
          };
        }
        await queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextTree(projectId, tab.scheme, tab.workId),
        });
        onCommitted(tab.documentId, {
          scheme: tab.scheme,
          path: replaceBasename(tab.path, name),
          name,
          ...(tab.workId ? { workId: tab.workId } : {}),
        });
        return { status: "committed" };
      }

      const moved = await moveContextEntry(projectId, tab.scheme, {
        path: stripLeadingSlash(tab.path),
        ...(tab.workId ? { sourceWorkId: tab.workId } : {}),
        destinationScheme: destination.scheme,
        destinationFolderPath: stripLeadingSlash(
          destination.folderPath === "/" ? "" : destination.folderPath,
        ),
        ...(destinationWorkId ? { destinationWorkId } : {}),
        ...(name !== tab.name ? { newName: name } : {}),
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
          queryKey: projectQueryKeys.contextTree(projectId, moved.scheme, destinationWorkId),
        }),
      ]);
      onCommitted(tab.documentId, {
        scheme: moved.scheme,
        path: `/${moved.path}`,
        name: moved.name,
        ...(destinationWorkId ? { workId: destinationWorkId } : {}),
      });
      return { status: "committed" };
    } catch {
      return { status: "error", message: t`Couldn't save this document's home. Try again.` };
    }
  };
}
