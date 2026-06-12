// @ts-nocheck
/**
 * Workbench-level coordination state (Zustand vanilla store + React context).
 *
 * Workbench list rows live in React Query. This store holds optimistic ops
 * around them — rename, soft-delete + undo window.
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { deleteWorkbench } from "@/client/api/workbenches-api";
import {
  patchWorkbenchInList,
  readWorkbenchList,
  removeWorkbenchFromList,
  restoreWorkbenchToList,
  upsertWorkbenchInList,
} from "@/client/query/workbench-list-cache";
import type { WorkbenchStoreActions, WorkbenchStoreState } from "./types";
import { suppressWorkbenchListId, unsuppressWorkbenchListId } from "./workbench-list-suppressions";

type WorkbenchStoreSlice = WorkbenchStoreState & WorkbenchStoreActions;

export type WorkbenchStoreSeed = {
  now: number;
};

type WorkbenchStoreConfig = WorkbenchStoreSeed & {
  queryClient: QueryClient;
};

export type WorkbenchStoreApi = StoreApi<WorkbenchStoreSlice>;

function selectWorkbenchActions(state: WorkbenchStoreSlice): WorkbenchStoreActions {
  return {
    ensureWorkbench: state.ensureWorkbench,
    rename: state.rename,
    softDelete: state.softDelete,
    undoSoftDelete: state.undoSoftDelete,
    finalizeSoftDelete: state.finalizeSoftDelete,
  };
}

export function createWorkbenchStore(config: WorkbenchStoreConfig): WorkbenchStoreApi {
  const { now, queryClient } = config;
  return createStore<WorkbenchStoreSlice>()(
    devtools(
      (set, get) => ({
        now,
        pendingDelete: null,

        ensureWorkbench(workbench) {
          upsertWorkbenchInList(queryClient, workbench);
        },

        rename(id, title) {
          const trimmed = title.trim();
          if (!trimmed) return;
          patchWorkbenchInList(queryClient, id, {
            title: trimmed,
            updatedAt: new Date().toISOString(),
          });
        },

        softDelete(id, source) {
          const client = queryClient;
          const list = readWorkbenchList(client);
          const target = source ?? list?.find((p) => p.id === id);
          if (!target) return false;

          const superseded = get().pendingDelete;
          if (superseded && superseded.workbench.id !== id) {
            void deleteWorkbench(superseded.workbench.id).finally(() => {
              unsuppressWorkbenchListId(superseded.workbench.id);
            });
          }

          suppressWorkbenchListId(id);
          removeWorkbenchFromList(client, id);

          set((state) => ({
            pendingDelete: { workbench: target, deletedAt: state.now },
          }));
          return true;
        },

        undoSoftDelete(id) {
          const { pendingDelete } = get();
          if (!pendingDelete || pendingDelete.workbench.id !== id) return;
          unsuppressWorkbenchListId(id);
          restoreWorkbenchToList(queryClient, pendingDelete.workbench);
          set({ pendingDelete: null });
        },

        finalizeSoftDelete(id) {
          unsuppressWorkbenchListId(id);
          set((state) => ({
            pendingDelete:
              state.pendingDelete && state.pendingDelete.workbench.id === id
                ? null
                : state.pendingDelete,
          }));
        },
      }),
      { name: "workbench-store", enabled: import.meta.env.DEV },
    ),
  );
}

const WorkbenchStoreContext = createContext<WorkbenchStoreApi | null>(null);

function useWorkbenchStoreApi(): WorkbenchStoreApi {
  const store = useContext(WorkbenchStoreContext);
  if (!store) {
    throw new Error("useWorkbenchStore must be used within WorkbenchStoreProvider");
  }
  return store;
}

export function WorkbenchStoreProvider({
  now,
  children,
}: WorkbenchStoreSeed & { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [store] = useState(() => createWorkbenchStore({ now, queryClient }));

  useEffect(() => {
    store.setState((state) => (state.now === now ? state : { ...state, now }));
  }, [store, now]);

  return <WorkbenchStoreContext.Provider value={store}>{children}</WorkbenchStoreContext.Provider>;
}

export function useWorkbenchStore<T>(selector: (state: WorkbenchStoreSlice) => T): T {
  return useStore(useWorkbenchStoreApi(), selector);
}

export function useWorkbenchActions(): WorkbenchStoreActions {
  return useStore(useWorkbenchStoreApi(), useShallow(selectWorkbenchActions));
}
