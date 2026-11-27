import type {
  ContextRemovalCoordinator,
  RemovalCommand,
} from "@/client/project-shell/context-removal-coordinator";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ProjectStandings } from "@/core/tree-list/project-standings";

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
  signInRequired(): void;
  signInRestored(): void;
}): ListRemovalObserver {
  const { projectId, standings, removal, registry } = input;
  const cleared = new Set<string>();
  let ended: EndedSources | null = null;
  let retained: string[] = [];
  let copies: ReadonlySet<string> = new Set();
  let askedToSignIn = false;
  let stopped = false;

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
    } else if (status !== "unauthenticated" && askedToSignIn) {
      askedToSignIn = false;
      input.signInRestored();
    }

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
