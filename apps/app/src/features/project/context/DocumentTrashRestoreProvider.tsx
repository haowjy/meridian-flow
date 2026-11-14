/** One project-lifetime owner for Trash restore progress and outcomes. */
import { plural, t } from "@lingui/core/macro";
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import { lastSettlements, listRecords } from "@meridian/project-tree";
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
import { useTreeList } from "@/client/query/useProjectTree";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { useAccountId, useOptionalContextRemovalCoordinator } from "./account-feature-context";
import { useEntryActions } from "./entry-drag/entry-actions";
import { runDelete } from "./entry-drag/entry-failure";
import { leaveSelections } from "./entry-drag/selection";

/** `restored`: the document is back in the tree, so a view of it in Trash follows it there. */
export type TrashRestoreState = { kind: "restored" } | { kind: "failed"; message: string };

type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  /** Restores entries to where they were: a `restore` record each; each shows its own outcome. */
  restore: (entries: readonly DocumentTrashEntry[]) => void;
  /**
   * Restores entries into a destination (a drag out of Trash). They leave the Trash list and
   * appear in the destination at once; one the server refuses goes back to Trash with its reason
   * in `states`. `destinationName` is what the notice says.
   */
  restoreInto: (
    entries: readonly DocumentTrashEntry[],
    destination: TreeDestination,
    destinationName: string,
  ) => void;
};

type RestoredNotice = {
  id: number;
  text: string;
  /** Puts the restored documents back in Trash. */
  undo?: () => void;
};

/** A restore the list has taken and the server has not answered: its record, and what to put back if it refuses. */
type Awaiting = { entry: DocumentTrashEntry; place: number };

const RESTORED_MARK_MS = 10_000;

const RestoreContext = createContext<RestoreContextValue | null>(null);

export function DocumentTrashRestoreProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const removal = useOptionalContextRemovalCoordinator();
  const actions = useEntryActions(projectId);
  const accountId = useAccountId();
  const projectList = useTreeList({ kind: "project", projectId });
  const accountList = useTreeList({ kind: "account", userId: accountId });
  const [notice, setNotice] = useState<RestoredNotice | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());
  const awaiting = useRef(new Map<string, Awaiting>());

  const setState = useCallback((documentId: string, state: TrashRestoreState | null) => {
    setStates((current) => {
      const next = new Map(current);
      if (state) next.set(documentId, state);
      else next.delete(documentId);
      return next;
    });
  }, []);

  /** The view of a restored document in Trash follows it out; the mark ends once it has had time to. */
  const markRestored = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        setState(id, { kind: "restored" });
        window.setTimeout(
          () =>
            setStates((current) => {
              if (current.get(id)?.kind !== "restored") return current;
              const next = new Map(current);
              next.delete(id);
              return next;
            }),
          RESTORED_MARK_MS,
        );
      }
    },
    [setState],
  );

  const fail = useCallback(
    (entry: DocumentTrashEntry, place: number, reason?: string) => {
      putBackInTrash(queryClient, projectId, entry, place);
      setState(entry.documentId, {
        kind: "failed",
        message: reason
          ? t`Couldn't restore ${entry.name}. ${reason}`
          : t`Couldn't restore ${entry.name}. Try again.`,
      });
    },
    [projectId, queryClient, setState],
  );

  // A refusal comes back as a settlement on the `restore` record; until then the entry is restored.
  useEffect(() => {
    const check = () => {
      for (const session of [projectList.session, accountList.session]) {
        if (!session) continue;
        const settled = lastSettlements(session.getSnapshot().doc);
        for (const [record, { entry, place }] of awaiting.current) {
          const settlement = settled.get(record);
          if (!settlement) continue;
          awaiting.current.delete(record);
          if (settlement.to === "refused") fail(entry, place, settlement.reason);
        }
      }
    };
    const stops = [projectList.session, accountList.session].map((session) =>
      session?.subscribe(check),
    );
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [projectList.session, accountList.session, fail]);

  /** Appends the entries' `restore` records, one update per list; returns whether the lists took them. */
  const append = useCallback(
    (
      entries: readonly DocumentTrashEntry[],
      listed: readonly DocumentTrashEntry[],
      destination?: TreeDestination,
    ) => {
      const held = entries.map((entry) => ({ entry, ...actions.holding(entry.documentId) }));
      for (const list of new Set(held.map((item) => item.list))) {
        const mine = held.filter((item) => item.list === list);
        const result = list.restore(mine.map(({ entry }) => entry.documentId));
        if (!result.ok) return false;
        const session = list === actions.account ? accountList.session : projectList.session;
        const records = session ? listRecords(session.getSnapshot().doc) : [];
        for (const [index, { entry }] of mine.entries()) {
          if (destination)
            list.move(
              entry.documentId,
              destination.parentId,
              destination.index === undefined ? undefined : destination.index + index,
            );
          const made = records
            .filter((record) => record.type === "restore" && record.node === entry.documentId)
            .at(-1);
          if (made) awaiting.current.set(made.id, { entry, place: indexIn(listed, entry) });
        }
      }
      return true;
    },
    [actions, accountList.session, projectList.session],
  );

  const restore = useCallback(
    (requested: readonly DocumentTrashEntry[]) => {
      const entries = requested;
      if (entries.length === 0) return;
      leaveSelections(entries.map(({ documentId }) => ({ kind: "file", id: documentId })));
      const listed = trashEntries(queryClient, projectId);
      if (!append(entries, listed)) {
        for (const entry of entries) fail(entry, indexIn(listed, entry));
        return;
      }
      markRestored(entries.map(({ documentId }) => documentId));
      removeFromTrash(
        queryClient,
        projectId,
        entries.map(({ documentId }) => documentId),
      );
      setNotice({
        id: Date.now(),
        text:
          entries.length === 1 && entries[0]
            ? t`Restored ${entries[0].name}.`
            : plural(entries.length, { one: "Restored # file.", other: "Restored # files." }),
      });
    },
    [append, fail, markRestored, projectId, queryClient],
  );

  const restoreInto = useCallback(
    (
      dragged: readonly DocumentTrashEntry[],
      destination: TreeDestination,
      destinationName: string,
    ) => {
      const entries = dragged;
      if (entries.length === 0) return;
      const ids = entries.map(({ documentId }) => documentId);
      leaveSelections(ids.map((id) => ({ kind: "file", id })));
      const listed = trashEntries(queryClient, projectId);
      if (!append(entries, listed, destination)) {
        for (const entry of entries) fail(entry, indexIn(listed, entry));
        return;
      }
      markRestored(ids);
      removeFromTrash(queryClient, projectId, ids);
      setNotice({
        id: Date.now(),
        text: restoredText(entries, destinationName),
        undo: () =>
          void runDelete(
            { actions, projectId, removal },
            entries.map((entry) => ({
              kind: "file" as const,
              id: entry.documentId,
              name: entry.name,
            })),
          ),
      });
    },
    [actions, append, fail, markRestored, projectId, queryClient, removal],
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

function restoredText(restored: readonly DocumentTrashEntry[], destinationName: string): string {
  const [only] = restored;
  if (restored.length === 1 && only) return t`Restored ${only.name} to ${destinationName}.`;
  return plural(restored.length, {
    one: `Restored # item to ${destinationName}.`,
    other: `Restored # items to ${destinationName}.`,
  });
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
      className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-md bg-foreground px-3 py-1.5 text-background text-xs shadow-float"
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
