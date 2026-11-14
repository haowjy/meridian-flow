/**
 * Reads a project's list for the documents the app is holding (views, recent routes, local
 * copies) and acts on what it says: a document in Trash leaves the views and the recents; a
 * document back in the tree is let back; a purged node's local copy is deleted, and so are the
 * copies of a project the account lost access to. Nothing is polled: it runs when the list
 * changes.
 *
 * A `delete` closes the view but keeps the local copy and its session until its unsent edits are
 * acknowledged; only a `purge` (or lost access) makes the copy something that cannot come back.
 */
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ContextRemovalCoordinator, RemovalCommand } from "./context-removal-coordinator";
import type { ProjectStandings } from "./project-standings";

export function observeListRemovals(input: {
  projectId: string;
  standings: Pick<ProjectStandings, "watch" | "standing" | "status">;
  removal: Pick<
    ContextRemovalCoordinator,
    "applyRemovals" | "clearLocalCopies" | "watchedDocumentIds"
  >;
  registry: Pick<LiveDocumentSessionRegistry, "localCopies" | "observeRetainedLiveDocuments">;
}): () => void {
  const { projectId, standings, removal, registry } = input;
  const cleared = new Set<string>();
  /** Sessions kept open for unsent edits after their view went: a purge ends them too. */
  let retained: string[] = [];
  let swept = false;
  let stopped = false;

  const clear = (documentIds: readonly string[]) => {
    const fresh = documentIds.filter((id) => !cleared.has(id));
    for (const id of fresh) cleared.add(id);
    if (fresh.length > 0) void removal.clearLocalCopies(fresh).catch(reportError);
  };

  const refresh = () => {
    if (stopped) return;
    const ids = [...new Set([...removal.watchedDocumentIds(projectId), ...retained])];
    // The account lost the project: its views close and its copies cannot come back to it.
    if (standings.status(projectId) === "denied") {
      removal.applyRemovals(ids.map((documentId) => ({ kind: "gone", projectId, documentId })));
      clear(ids);
      return;
    }
    const commands: RemovalCommand[] = [];
    const purged: string[] = [];
    for (const documentId of ids) {
      const standing = standings.standing(projectId, documentId);
      if (standing.kind === "in-trash" || standing.kind === "purged")
        commands.push({ kind: "gone", projectId, documentId });
      else if (standing.kind === "in-tree") commands.push({ kind: "back", projectId, documentId });
      if (standing.kind === "purged") purged.push(documentId);
    }
    removal.applyRemovals(commands);
    clear(purged);
    // A tab that crashed half way through a deletion leaves its copy behind: it is found here.
    if (!swept && standings.status(projectId) !== "waiting") {
      swept = true;
      void registry
        .localCopies()
        .then((copies) =>
          clear(copies.filter((id) => standings.standing(projectId, id).kind === "purged")),
        )
        .catch(reportError);
    }
  };

  const stopRetained = registry.observeRetainedLiveDocuments((snapshot) => {
    retained = snapshot.filter((ref) => ref.projectId === projectId).map((ref) => ref.documentId);
    refresh();
  });
  const stop = standings.watch(projectId, refresh);
  refresh();
  return () => {
    stopped = true;
    stopRetained();
    stop();
  };
}
