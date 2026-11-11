/** One project-lifetime owner for Trash restore progress and outcomes. */
import { plural, t } from "@lingui/core/macro";
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  addPendingRestores,
  dropPendingRestores,
  type RestoreDestination,
  settlePendingRestores,
} from "@/client/trash-restore/pending-restores";
import { documentLocationName } from "../../chat/document-display-name";
import {
  useOptionalAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
} from "./account-feature-context";
import { runDelete } from "./entry-drag/entry-failure";
import { restoreTrashedDocuments, type TrashRestoreOutcome } from "./restore-trashed-document";

export type TrashRestoreState = { kind: "restoring" } | { kind: "failed"; message: string };

type AfterRestore = (
  outcome: Extract<TrashRestoreOutcome, { kind: "living" }>,
) => Promise<string | null>;

type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  /** Restores one entry to its original path. */
  restore: (entry: DocumentTrashEntry, afterRestore?: AfterRestore) => void;
  /**
   * Restores entries into a destination (a drag out of Trash). They leave the Trash list and
   * appear in the destination at once; one that fails goes back to Trash with its reason in
   * `states`. `destinationName` is what the notice says.
   */
  restoreInto: (
    entries: readonly DocumentTrashEntry[],
    destination: RestoreDestination,
    destinationName: string,
  ) => void;
};

type RestoredNotice = {
  id: number;
  text: string;
  /** Puts the restored documents back in Trash. */
  undo?: () => void;
};

const RestoreContext = createContext<RestoreContextValue | null>(null);

export function DocumentTrashRestoreProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const removal = useOptionalContextRemovalCoordinator();
  const [notice, setNotice] = useState<RestoredNotice | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());
  const restoring = useRef(new Set<string>());

  const setState = useCallback((documentId: string, state: TrashRestoreState | null) => {
    setStates((current) => {
      const next = new Map(current);
      if (state) next.set(documentId, state);
      else next.delete(documentId);
      return next;
    });
  }, []);

  /** One entry's outcome, shown on it. Returns whether it is living now. */
  const settle = useCallback(
    async (
      entry: DocumentTrashEntry,
      outcome: TrashRestoreOutcome | "network",
      afterRestore?: AfterRestore,
    ) => {
      if (outcome !== "network" && outcome.kind === "living") {
        const failure = afterRestore ? await afterRestore(outcome) : null;
        setState(entry.documentId, failure ? { kind: "failed", message: failure } : null);
        return true;
      }
      const kind = outcome === "network" ? "network" : outcome.kind;
      setState(
        entry.documentId,
        kind === "superseded"
          ? null
          : { kind: "failed", message: restoreFailureMessage(entry.name, kind) },
      );
      return false;
    },
    [setState],
  );

  const restore = useCallback(
    (entry: DocumentTrashEntry, afterRestore?: AfterRestore) => {
      if (restoring.current.has(entry.documentId)) return;
      restoring.current.add(entry.documentId);
      setState(entry.documentId, { kind: "restoring" });
      void restoreTrashedDocuments(queryClient, projectId, [entry])
        .then(async (outcomes) => {
          const outcome = outcomes.get(entry.documentId);
          if (!outcome) throw new Error("Restore returned no result");
          await settle(entry, outcome, afterRestore);
          if (outcome.kind === "living" && outcome.landedAt)
            setNotice({
              id: Date.now(),
              text: t`Restored at ${documentLocationName(outcome.landedAt)}.`,
            });
        })
        .catch(() => settle(entry, "network"))
        .finally(() => restoring.current.delete(entry.documentId));
    },
    [projectId, queryClient, settle, setState],
  );

  const restoreInto = useCallback(
    (
      dragged: readonly DocumentTrashEntry[],
      destination: RestoreDestination,
      destinationName: string,
    ) => {
      const entries = dragged.filter((entry) => !restoring.current.has(entry.documentId));
      if (entries.length === 0) return;
      const ids = entries.map(({ documentId }) => documentId);
      for (const id of ids) restoring.current.add(id);
      for (const id of ids) setState(id, { kind: "restoring" });
      const listed = trashEntries(queryClient, projectId);
      const places = new Map(entries.map((entry) => [entry.documentId, indexIn(listed, entry)]));
      removeFromTrash(queryClient, projectId, ids);
      addPendingRestores(
        projectId,
        entries.map((entry, index) => ({
          documentId: entry.documentId,
          name: entry.name,
          // The first goes at the dropped position; the server places the rest after it in order.
          destination: index === 0 ? destination : { parent: destination.parent },
        })),
      );
      const finish = async (
        outcomes: Awaited<ReturnType<typeof restoreTrashedDocuments>> | null,
      ) => {
        const restored: DocumentTrashEntry[] = [];
        for (const entry of entries) {
          const outcome = outcomes?.get(entry.documentId) ?? "network";
          if (await settle(entry, outcome)) restored.push(entry);
          else putBackInTrash(queryClient, projectId, entry, places.get(entry.documentId) ?? 0);
        }
        const restoredIds = new Set(restored.map(({ documentId }) => documentId));
        dropPendingRestores(
          projectId,
          ids.filter((id) => !restoredIds.has(id)),
        );
        settlePendingRestores(projectId, [...restoredIds]);
        if (restored.length < entries.length)
          await queryClient.invalidateQueries({
            queryKey: projectQueryKeys.documentTrash(projectId),
          });
        if (restored.length === 0) return;
        setNotice({
          id: Date.now(),
          text: restoredText(restored, entries.length, destinationName),
          ...(resources
            ? {
                undo: () => {
                  for (const entry of restored)
                    void runDelete(
                      { resources, projectId, removal },
                      { kind: "file", id: entry.documentId, name: entry.name },
                    );
                },
              }
            : {}),
        });
      };
      // A request that never answered fails every entry the same way: "Try again."
      void restoreTrashedDocuments(queryClient, projectId, entries, destination)
        .then(finish, () => finish(null))
        .finally(() => {
          for (const id of ids) restoring.current.delete(id);
        });
    },
    [projectId, queryClient, removal, resources, settle, setState],
  );

  const value = useMemo(() => ({ states, restore, restoreInto }), [states, restore, restoreInto]);
  return (
    <RestoreContext.Provider value={value}>
      {children}
      <RestoredNoticeToast notice={notice} onDismiss={() => setNotice(null)} />
    </RestoreContext.Provider>
  );
}

export function useDocumentTrashRestore(): RestoreContextValue {
  const value = useContext(RestoreContext);
  if (!value) throw new Error("Document Trash restore requires its project provider");
  return value;
}

function trashEntries(queryClient: QueryClient, projectId: string): DocumentTrashEntry[] {
  return (
    queryClient.getQueryData<ListDocumentTrashResponse>(projectQueryKeys.documentTrash(projectId))
      ?.documents ?? []
  );
}

function indexIn(listed: readonly DocumentTrashEntry[], entry: DocumentTrashEntry): number {
  return Math.max(
    0,
    listed.findIndex(({ documentId }) => documentId === entry.documentId),
  );
}

function removeFromTrash(queryClient: QueryClient, projectId: string, ids: readonly string[]) {
  queryClient.setQueryData<ListDocumentTrashResponse>(
    projectQueryKeys.documentTrash(projectId),
    (current) =>
      current
        ? { documents: current.documents.filter(({ documentId }) => !ids.includes(documentId)) }
        : current,
  );
}

/** A refused entry returns to the place it left, so its failure shows where the writer dragged it from. */
function putBackInTrash(
  queryClient: QueryClient,
  projectId: string,
  entry: DocumentTrashEntry,
  index: number,
) {
  queryClient.setQueryData<ListDocumentTrashResponse>(
    projectQueryKeys.documentTrash(projectId),
    (current) => {
      if (!current || current.documents.some(({ documentId }) => documentId === entry.documentId))
        return current;
      const documents = [...current.documents];
      documents.splice(index, 0, entry);
      return { documents };
    },
  );
}

function restoredText(
  restored: readonly DocumentTrashEntry[],
  requested: number,
  destinationName: string,
): string {
  const [only] = restored;
  if (restored.length === 1 && requested === 1 && only)
    return t`Restored ${only.name} to ${destinationName}.`;
  if (restored.length === requested)
    return plural(restored.length, {
      one: `Restored # item to ${destinationName}.`,
      other: `Restored # items to ${destinationName}.`,
    });
  return t`Restored ${restored.length} of ${requested} items to ${destinationName}.`;
}

function RestoredNoticeToast({
  notice,
  onDismiss,
}: {
  notice: RestoredNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, notice.undo ? 8_000 : 4_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      role="status"
      className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-md bg-foreground px-3 py-1.5 text-background text-caption shadow-float"
    >
      <span>{notice.text}</span>
      {notice.undo ? (
        <button
          type="button"
          className="font-semibold underline underline-offset-2"
          onClick={() => {
            notice.undo?.();
            onDismiss();
          }}
        >
          {t`Undo`}
        </button>
      ) : null}
    </div>
  );
}

function restoreFailureMessage(
  name: string,
  outcome: "superseded" | "ancestor_taken" | "refused" | "destination_unavailable" | "network",
): string {
  if (outcome === "ancestor_taken") return t`Couldn't restore ${name}. A file is in the way.`;
  if (outcome === "destination_unavailable")
    return t`Couldn't restore ${name}. That folder is no longer available.`;
  if (outcome === "network") return t`Couldn't restore ${name}. Try again.`;
  return t`Couldn't restore ${name}.`;
}
