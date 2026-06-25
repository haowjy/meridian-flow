/**
 * Project-level coordination state (Zustand vanilla store + React context).
 *
 * Project list rows live in React Query. This store holds optimistic ops
 * around them — rename, soft-delete + undo window.
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { deleteProject } from "@/client/api/projects-api";
import {
  patchProjectInList,
  readProjectList,
  removeProjectFromList,
  restoreProjectToList,
  upsertProjectInList,
} from "@/client/query/project-list-cache";
import { suppressProjectListId, unsuppressProjectListId } from "./project-list-suppressions";
import type { ProjectStoreActions, ProjectStoreState } from "./types";

type ProjectStoreSlice = ProjectStoreState & ProjectStoreActions;

export type ProjectStoreSeed = {
  now: number;
};

type ProjectStoreConfig = ProjectStoreSeed & {
  queryClient: QueryClient;
};

export type ProjectStoreApi = StoreApi<ProjectStoreSlice>;

function selectProjectActions(state: ProjectStoreSlice): ProjectStoreActions {
  return {
    ensureProject: state.ensureProject,
    rename: state.rename,
    softDelete: state.softDelete,
    undoSoftDelete: state.undoSoftDelete,
    finalizeSoftDelete: state.finalizeSoftDelete,
  };
}

export function createProjectStore(config: ProjectStoreConfig): ProjectStoreApi {
  const { now, queryClient } = config;
  return createStore<ProjectStoreSlice>()(
    devtools(
      (set, get) => ({
        now,
        pendingDelete: null,

        ensureProject(project) {
          upsertProjectInList(queryClient, project);
        },

        rename(id, title) {
          const trimmed = title.trim();
          if (!trimmed) return;
          patchProjectInList(queryClient, id, {
            title: trimmed,
            updatedAt: new Date().toISOString(),
          });
        },

        softDelete(id, source) {
          const client = queryClient;
          const list = readProjectList(client);
          const target = source ?? list?.find((p) => p.id === id);
          if (!target) return false;

          const superseded = get().pendingDelete;
          if (superseded && superseded.project.id !== id) {
            void deleteProject(superseded.project.id).finally(() => {
              unsuppressProjectListId(superseded.project.id);
            });
          }

          suppressProjectListId(id);
          removeProjectFromList(client, id);

          set((state) => ({
            pendingDelete: { project: target, deletedAt: state.now },
          }));
          return true;
        },

        undoSoftDelete(id) {
          const { pendingDelete } = get();
          if (!pendingDelete || pendingDelete.project.id !== id) return;
          unsuppressProjectListId(id);
          restoreProjectToList(queryClient, pendingDelete.project);
          set({ pendingDelete: null });
        },

        finalizeSoftDelete(id) {
          unsuppressProjectListId(id);
          set((state) => ({
            pendingDelete:
              state.pendingDelete && state.pendingDelete.project.id === id
                ? null
                : state.pendingDelete,
          }));
        },
      }),
      { name: "project-store", enabled: import.meta.env.DEV },
    ),
  );
}

const ProjectStoreContext = createContext<ProjectStoreApi | null>(null);

function useProjectStoreApi(): ProjectStoreApi {
  const store = useContext(ProjectStoreContext);
  if (!store) {
    throw new Error("useProjectStore must be used within ProjectStoreProvider");
  }
  return store;
}

export function ProjectStoreProvider({
  now,
  children,
}: ProjectStoreSeed & { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [store] = useState(() => createProjectStore({ now, queryClient }));

  // Keep `store.now` fresh via a timer instead of route-loader refetches.
  useEffect(() => {
    const timer = setInterval(() => {
      store.setState((state) => ({ ...state, now: Date.now() }));
    }, 30_000);
    return () => clearInterval(timer);
  }, [store]);

  return <ProjectStoreContext.Provider value={store}>{children}</ProjectStoreContext.Provider>;
}

export function useProjectStore<T>(selector: (state: ProjectStoreSlice) => T): T {
  return useStore(useProjectStoreApi(), selector);
}

export function useProjectActions(): ProjectStoreActions {
  return useStore(useProjectStoreApi(), useShallow(selectProjectActions));
}
