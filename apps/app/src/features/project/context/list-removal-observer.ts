/**
 * Reads a project's list for the documents the app is holding (views, recent routes, local
 * copies) and acts on what it says. Nothing is polled: it runs when the list, the sources or the
 * browser's copies change.
 *
 * Two different things happen, and only the second is irreversible:
 * - **Views close** when a document cannot be shown right now: it is in Trash, purged, or its
 *   source ended (a deleted Work or chat, which can be restored). The copy and its session stay,
 *   with any unsent text, until the document comes back or is gone for good.
 * - **A copy is deleted** only when the document is gone for good (`goneForGood`, the one
 *   predicate every deletion goes through): its node's purge in the list, its source purged, or
 *   the account removed from the project. Losing the connection, an expired sign-in and a source
 *   that ended but can be restored are not final.
 */
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ContextRemovalCoordinator, RemovalCommand } from "./context-removal-coordinator";
import type { ProjectStandings } from "./project-standings";

/** What the sources queries said, and when: an absence is believed only if it was read after the node was first seen. */
export type SourceFacts = {
  live: ReadonlySet<string>;
  /** Ended and restorable: a deleted Work's or chat's source. */
  ended: ReadonlySet<string>;
  fetchedAt: number;
};

export type ListRemovalObserver = {
  setSources(facts: SourceFacts | null): void;
  stop(): void;
};

export function observeListRemovals(input: {
  projectId: string;
  standings: Pick<ProjectStandings, "watch" | "standing" | "status" | "inProjectList">;
  removal: Pick<
    ContextRemovalCoordinator,
    "applyRemovals" | "clearLocalCopies" | "watchedDocumentIds" | "shownAmong"
  >;
  /** Main shows a document that went to Trash: it shows its Trash view (who deleted it, Restore). */
  showTrashed(documentId: string): void;
  registry: Pick<
    LiveDocumentSessionRegistry,
    "observeLocalCopies" | "observeRetainedLiveDocuments"
  >;
  /** Asks the sources again: a source the list names that the sources do not is read once more before it counts as purged. */
  refreshSources(): void;
  /** The sign-in did not hold: the writer signs in again. Called once per time it begins. */
  signInRequired(): void;
}): ListRemovalObserver {
  const { projectId, standings, removal, registry, showTrashed } = input;
  const cleared = new Set<string>();
  const shownTrashed = new Set<string>();
  /** When the list first named each source the sources did not. */
  const unlisted = new Map<string, number>();
  let facts: SourceFacts | null = null;
  /** Sessions kept open for unsent edits after their view went: a purge ends them too. */
  let retained: string[] = [];
  /** Every document this browser holds a copy of: a purge arrives whether or not a view remains. */
  let copies: ReadonlySet<string> = new Set();
  let askedToSignIn = false;
  let stopped = false;

  const sourceState = (source: string): "unknown" | "live" | "ended" | "purged" => {
    if (!facts) return "unknown";
    if (facts.live.has(source)) return "live";
    if (facts.ended.has(source)) return "ended";
    const seen = unlisted.get(source);
    if (seen === undefined) {
      unlisted.set(source, Date.now());
      input.refreshSources();
      return "unknown";
    }
    return facts.fetchedAt > seen ? "purged" : "unknown";
  };

  /** Whether the document can never come back to this account. */
  const goneForGood = (documentId: string): boolean => {
    const standing = standings.standing(projectId, documentId);
    if (standing.kind === "purged") return true;
    if (standing.kind !== "in-tree" && standing.kind !== "in-trash") return false;
    if (standings.status(projectId) === "denied" && standings.inProjectList(projectId, documentId))
      return true;
    return sourceState(standing.node.source) === "purged";
  };

  const clear = (documentIds: readonly string[]) => {
    const fresh = documentIds.filter((id) => !cleared.has(id));
    for (const id of fresh) cleared.add(id);
    if (fresh.length > 0)
      void removal.clearLocalCopies(fresh).catch((error: unknown) => reportError(error));
  };

  const refresh = () => {
    if (stopped) return;
    const status = standings.status(projectId);
    if (status === "unauthenticated" && !askedToSignIn) {
      askedToSignIn = true;
      input.signInRequired();
    } else if (status !== "unauthenticated") askedToSignIn = false;

    const viewIds = [...new Set([...removal.watchedDocumentIds(projectId), ...retained])];
    const commands: RemovalCommand[] = [];
    for (const documentId of viewIds) {
      const standing = standings.standing(projectId, documentId);
      const sourceEnded =
        (standing.kind === "in-tree" || standing.kind === "in-trash") &&
        ["ended", "purged"].includes(sourceState(standing.node.source));
      if (
        standing.kind === "in-trash" ||
        standing.kind === "purged" ||
        sourceEnded ||
        (status === "denied" && standings.inProjectList(projectId, documentId))
      )
        commands.push({ kind: "gone", projectId, documentId });
      else if (standing.kind === "in-tree") {
        commands.push({ kind: "back", projectId, documentId });
        shownTrashed.delete(documentId);
      }
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
    clear([...new Set([...viewIds, ...copies])].filter(goneForGood));
  };

  const stopRetained = registry.observeRetainedLiveDocuments((snapshot) => {
    retained = snapshot.filter((ref) => ref.projectId === projectId).map((ref) => ref.documentId);
    refresh();
  });
  const stopCopies = registry.observeLocalCopies((documents) => {
    copies = documents;
    refresh();
  });
  const stop = standings.watch(projectId, refresh);
  refresh();
  return {
    setSources(next) {
      facts = next;
      refresh();
    },
    stop() {
      stopped = true;
      stopRetained();
      stopCopies();
      stop();
    },
  };
}
