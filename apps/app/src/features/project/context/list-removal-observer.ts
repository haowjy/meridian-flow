/**
 * Reads a project's list for the documents the app is holding (views, recent routes, local
 * copies) and acts on what it says: a document in Trash leaves the views and the recents; a
 * document back in the tree is let back; a purged node's local copy is deleted, and so are the
 * copies of a project the account lost access to and of a source that ended (its Work deleted, its
 * chat deleted). An archived Work's source stays, so its documents keep their unsent text. Nothing is polled: it runs when the list
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
    "applyRemovals" | "clearLocalCopies" | "watchedDocumentIds" | "shownAmong"
  >;
  /** Main shows a document that went to Trash: it shows its Trash view (who deleted it, Restore). */
  showTrashed(documentId: string): void;
  registry: Pick<LiveDocumentSessionRegistry, "localCopies" | "observeRetainedLiveDocuments">;
  /** The ids of the sources the account can still read in the project; null until they are known. */
  sourceIds: ReadonlySet<string> | null;
}): () => void {
  const { projectId, standings, removal, registry, sourceIds, showTrashed } = input;
  const cleared = new Set<string>();
  const shownTrashed = new Set<string>();
  /** Sessions kept open for unsent edits after their view went: a purge ends them too. */
  let retained: string[] = [];
  let swept = false;
  let stopped = false;

  const clear = (documentIds: readonly string[]) => {
    const fresh = documentIds.filter((id) => !cleared.has(id));
    for (const id of fresh) cleared.add(id);
    if (fresh.length > 0) void removal.clearLocalCopies(fresh).catch(reportError);
  };

  const endedSource = (standing: ReturnType<typeof standings.standing>) =>
    sourceIds !== null &&
    (standing.kind === "in-tree" || standing.kind === "in-trash") &&
    !sourceIds.has(standing.node.source);

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
      // A node whose source ended can never come back to this account, whatever its state.
      const ended = endedSource(standing);
      if (standing.kind === "in-trash" || standing.kind === "purged" || ended)
        commands.push({ kind: "gone", projectId, documentId });
      else if (standing.kind === "in-tree") {
        commands.push({ kind: "back", projectId, documentId });
        shownTrashed.delete(documentId);
      }
      if (standing.kind === "purged" || ended) purged.push(documentId);
    }
    const trashed = commands.flatMap((command) =>
      command.kind === "gone" &&
      standings.standing(projectId, command.documentId).kind === "in-trash"
        ? [command.documentId]
        : [],
    );
    const shown = removal.shownAmong(projectId, trashed);
    removal.applyRemovals(commands);
    if (shown && !shownTrashed.has(shown)) {
      shownTrashed.add(shown);
      showTrashed(shown);
    }
    clear(purged);
    // A tab that crashed half way through a deletion leaves its copy behind: it is found here.
    if (!swept && standings.status(projectId) !== "waiting") {
      swept = true;
      void registry
        .localCopies()
        .then((copies) =>
          clear(
            copies.filter((id) => {
              const standing = standings.standing(projectId, id);
              return standing.kind === "purged" || endedSource(standing);
            }),
          ),
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
