/** One project-lifetime owner for Trash restore progress and outcomes, by node id. */
import { plural, t } from "@lingui/core/macro";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { StatusToast, type StatusToastNotice } from "@/components/app/StatusToast";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { useOptionalContextRemovalCoordinator } from "./account-feature-context";
import type { EntryRef } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { runDelete } from "./entry-drag/entry-failure";
import { leaveSelections } from "./entry-drag/selection";

/** What a restore needs of a Trash entry: the record names the node, the notices its name. */
export type Restorable = { ref: EntryRef; name: string };

export type TrashRestoreState = { kind: "restored" };

/** `restored`: the node is back in the tree, so a view of it in Trash follows it there. */
type RestoreContextValue = {
  states: ReadonlyMap<string, TrashRestoreState>;
  /** Restores entries to where they were: a `restore` record each; each shows its own outcome. */
  restore: (entries: readonly Restorable[]) => void;
  /**
   * Restores entries into a destination (a drag out of Trash). They leave the Trash list and
   * appear in the destination at once; one the server refuses goes back to Trash with its reason
   * in `states`. `destinationName` is what the notice says.
   */
  restoreInto: (
    entries: readonly Restorable[],
    destination: TreeDestination,
    destinationName: string,
  ) => void;
};

/** `undo` puts the restored documents back in Trash. */
type RestoredNotice = StatusToastNotice;

const RESTORED_MARK_MS = 10_000;

const RestoreContext = createContext<RestoreContextValue | null>(null);

export function DocumentTrashRestoreProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const removal = useOptionalContextRemovalCoordinator();
  const actions = useEntryActions(projectId);
  const [notice, setNotice] = useState<RestoredNotice | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, TrashRestoreState>>(() => new Map());

  const setState = useCallback((node: string, state: TrashRestoreState | null) => {
    setStates((current) => {
      const next = new Map(current);
      if (state) next.set(node, state);
      else next.delete(node);
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

  /** Appends the entries' `restore` records, one update per list. */
  const append = useCallback(
    (entries: readonly Restorable[], destination?: TreeDestination) => {
      const held = entries.map((entry) => ({ entry, ...actions.holding(entry.ref.id) }));
      for (const list of new Set(held.map((item) => item.list))) {
        const mine = held.filter((item) => item.list === list);
        list.restore(mine.map(({ entry }) => entry.ref.id));
        for (const [index, { entry }] of mine.entries()) {
          if (destination)
            list.move(
              entry.ref.id,
              destination.parentId,
              destination.index === undefined ? undefined : destination.index + index,
            );
        }
      }
    },
    [actions],
  );

  const restore = useCallback(
    (requested: readonly Restorable[]) => {
      const entries = requested;
      if (entries.length === 0) return;
      leaveSelections(entries.map(({ ref }) => ref));
      append(entries);
      markRestored(entries.map(({ ref }) => ref.id));
      setNotice({
        id: Date.now(),
        text:
          entries.length === 1 && entries[0]
            ? t`Restored ${entries[0].name}.`
            : plural(entries.length, { one: "Restored # item.", other: "Restored # items." }),
      });
    },
    [append, markRestored],
  );

  const restoreInto = useCallback(
    (dragged: readonly Restorable[], destination: TreeDestination, destinationName: string) => {
      const entries = dragged;
      if (entries.length === 0) return;
      leaveSelections(entries.map(({ ref }) => ref));
      append(entries, destination);
      markRestored(entries.map(({ ref }) => ref.id));
      setNotice({
        id: Date.now(),
        text: restoredText(entries, destinationName),
        undo: () =>
          void runDelete(
            { actions, projectId, removal },
            entries.map(({ ref, name }) => ({ ...ref, name })),
          ),
      });
    },
    [actions, append, markRestored, projectId, removal],
  );

  const value = useMemo(() => ({ states, restore, restoreInto }), [states, restore, restoreInto]);
  return (
    <RestoreContext.Provider value={value}>
      {children}
      <StatusToast notice={notice} onDismiss={() => setNotice(null)} />
    </RestoreContext.Provider>
  );
}

export function useDocumentTrashRestore(): RestoreContextValue {
  const value = useContext(RestoreContext);
  if (!value) throw new Error("Document Trash restore requires its project provider");
  return value;
}

function restoredText(restored: readonly Restorable[], destinationName: string): string {
  const [only] = restored;
  if (restored.length === 1 && only) return t`Restored ${only.name} to ${destinationName}.`;
  return plural(restored.length, {
    one: `Restored # item to ${destinationName}.`,
    other: `Restored # items to ${destinationName}.`,
  });
}
