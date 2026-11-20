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
 *   predicate every deletion goes through): its node's purge in the list (Trash retention and a
 *   Work's purge both write one), or the account removed from the project. Losing the connection, an expired sign-in and a source
 *   that ended but can be restored are not final.
 */
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ContextRemovalCoordinator, RemovalCommand } from "./context-removal-coordinator";
import type { ProjectStandings } from "./project-standings";

/** The sources that ended and can still be restored: a deleted Work's or chat's. */
export type EndedSources = ReadonlySet<string>;

export type ListRemovalObserver = {
  setEndedSources(ended: EndedSources | null): void;
  stop(): void;
};

export function observeListRemovals(input: {
  projectId: string;
  standings: Pick<ProjectStandings, "watch" | "standing" | "status" | "inProjectList">;
  removal: Pick<
    ContextRemovalCoordinator,
    "applyRemovals" | "clearLocalCopies" | "watchedDocumentIds"
  >;
  registry: Pick<
    LiveDocumentSessionRegistry,
    "observeLocalCopies" | "observeRetainedLiveDocuments"
  >;
  /** The sign-in did not hold: the writer signs in again. Called once per time it begins. */
  signInRequired(): void;
}): ListRemovalObserver {
  const { projectId, standings, removal, registry } = input;
  const cleared = new Set<string>();
  let ended: EndedSources | null = null;
  /** Sessions kept open for unsent edits after their view went: a purge ends them too. */
  let retained: string[] = [];
  /** Every document this browser holds a copy of: a purge arrives whether or not a view remains. */
  let copies: ReadonlySet<string> = new Set();
  let askedToSignIn = false;
  let stopped = false;

  /** Whether the document can never come back to this account. */
  const goneForGood = (documentId: string): boolean => {
    const standing = standings.standing(projectId, documentId);
    if (standing.kind === "purged") return true;
    return (
      (standing.kind === "in-tree" || standing.kind === "in-trash") &&
      standings.status(projectId) === "denied" &&
      standings.inProjectList(projectId, documentId)
    );
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
        ended?.has(standing.node.source) === true;
      if (
        standing.kind === "in-trash" ||
        standing.kind === "purged" ||
        sourceEnded ||
        (status === "denied" && standings.inProjectList(projectId, documentId))
      )
        commands.push({ kind: "gone", projectId, documentId });
      else if (standing.kind === "in-tree") commands.push({ kind: "back", projectId, documentId });
    }
    removal.applyRemovals(commands);
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
    setEndedSources(next) {
      ended = next;
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
