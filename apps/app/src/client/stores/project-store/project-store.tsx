/**
 * Project-level coordination state (Zustand vanilla store + React context).
 *
 * Project list rows live in React Query. The store owns the account clock and
 * inserts confirmed new projects into that list ({@link ProjectStoreActions.ensureProject}).
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { upsertProjectInList } from "@/client/query/project-list-cache";
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
  };
}

export function createProjectStore(config: ProjectStoreConfig): ProjectStoreApi {
  const { now, queryClient } = config;
  return createStore<ProjectStoreSlice>()(
    devtools(
      () => ({
        now,

        ensureProject(project) {
          upsertProjectInList(queryClient, project);
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
