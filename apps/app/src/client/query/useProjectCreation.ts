/** Navigate-first project creation and destination-owned recovery state. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { CreateProjectRequest } from "@meridian/contracts/protocol";
import { QueryClientContext, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import { createProject, getProject } from "@/client/api/projects-api";
import { useProjectActions } from "@/client/stores";
import {
  createProjectWithRecovery,
  type ProjectCreationRecord,
  pendingProject,
  pendingProjectRouteState,
  readProjectCreation,
  removeProjectCreation,
  writeProjectCreation,
} from "./project-creation-cache";
import { projectQueryKeys } from "./project-query-keys";

type CreateProjectVariables = {
  id: string;
  title: string;
  project: Project;
};

function clearPendingProjectRoute(router: ReturnType<typeof useRouter>, projectId: string): void {
  const current = router.history.location;
  const pathname = new URL(current.href, window.location.origin).pathname;
  if (!pathname.startsWith(`/p/${projectId}`)) return;
  const { meridianPendingProject: _pending, ...state } = current.state as Record<string, unknown>;
  router.history.replace(current.href, state, { ignoreBlocker: true });
}

function useProjectCreationMutation(accountSignal: AbortSignal) {
  const client = useQueryClient();
  const { ensureProject } = useProjectActions();
  const router = useRouter();

  return useMutation<Project, Error, CreateProjectVariables>({
    mutationKey: ["projects", "create"],
    mutationFn: ({ id, title }) =>
      createProjectWithRecovery(
        { id, title },
        (input) => createProject(input satisfies CreateProjectRequest, { signal: accountSignal }),
        (id) => getProject(id, { signal: accountSignal }),
      ),
    onSuccess: (project, variables) => {
      if (accountSignal.aborted) {
        removeProjectCreation(client, variables.id);
        client.removeQueries({ queryKey: projectQueryKeys.detail(variables.id), exact: true });
        return;
      }
      ensureProject(project);
      client.setQueryData(projectQueryKeys.detail(project.id), project);
      if (readProjectCreation(client, variables.id)?.accountSignal === accountSignal)
        removeProjectCreation(client, variables.id);
      clearPendingProjectRoute(router, project.id);
    },
    onError: (error, variables) => {
      if (accountSignal.aborted) {
        removeProjectCreation(client, variables.id);
        client.removeQueries({ queryKey: projectQueryKeys.detail(variables.id), exact: true });
        return;
      }
      const record = readProjectCreation(client, variables.id);
      if (record?.accountSignal === accountSignal)
        writeProjectCreation(client, { ...record, status: "failed", error: error.message });
    },
  });
}

/** The create command inserts, navigates, then dispatches without waiting for the server. */
export function useCreateProject(userId: string, accountSignal: AbortSignal) {
  const client = useQueryClient();
  const router = useRouter();
  const mutation = useProjectCreationMutation(accountSignal);

  const create = useCallback(
    (input: { title: string }): string => {
      const title = input.title.trim();
      if (!title) throw new Error("Project title is required");
      const id = crypto.randomUUID();
      const project = pendingProject(id, title, userId);
      writeProjectCreation(client, {
        id,
        title,
        project,
        accountSignal,
        status: "pending",
        error: null,
      });
      client.setQueryData(projectQueryKeys.detail(id), project);
      void router.navigate({
        to: "/p/$projectId/$",
        params: { projectId: id, _splat: "works" },
        replace: false,
        state: (previous) => ({
          ...previous,
          ...pendingProjectRouteState({ id, title, userId }),
        }),
      });
      mutation.mutate({ id, title, project });
      return id;
    },
    [accountSignal, client, mutation, router, userId],
  );

  return { create };
}

export type ProjectCreationState = {
  status: "none" | "pending" | "failed";
  error: Error | null;
  retry: () => void;
  discard: () => void;
};

export function useProjectCreationState(
  projectId: string,
  accountSignal: AbortSignal,
): ProjectCreationState {
  const client = useQueryClient();
  const mutation = useProjectCreationMutation(accountSignal);
  const query = useQuery<ProjectCreationRecord | null>({
    queryKey: projectQueryKeys.projectCreation(projectId),
    queryFn: async () => null,
    enabled: false,
  });
  const record = query.data?.accountSignal === accountSignal ? query.data : undefined;
  useEffect(() => {
    const stale = query.data;
    if (!stale || stale.accountSignal === accountSignal) return;
    if (readProjectCreation(client, projectId)?.accountSignal === stale.accountSignal) {
      removeProjectCreation(client, projectId);
      client.removeQueries({ queryKey: projectQueryKeys.detail(projectId), exact: true });
    }
  }, [accountSignal, client, projectId, query.data]);

  const retry = useCallback(() => {
    if (record?.status !== "failed") return;
    writeProjectCreation(client, { ...record, status: "pending", error: null });
    mutation.mutate({ id: record.id, title: record.title, project: record.project });
  }, [client, mutation, record]);
  const discard = useCallback(() => {
    if (!record || (record.status !== "failed" && record.status !== "pending")) return;
    const list = client.getQueryData<Project[] | null>(projectQueryKeys.list);
    client.setQueryData<Project[] | null>(
      projectQueryKeys.list,
      list?.filter((project) => project.id !== projectId) ?? null,
    );
    client.removeQueries({ queryKey: projectQueryKeys.detail(projectId), exact: true });
    removeProjectCreation(client, projectId);
  }, [client, projectId, record]);

  return {
    status: record?.status ?? "none",
    error: record?.error ? new Error(record.error) : null,
    retry,
    discard,
  };
}

/** Dependent project reads pause for unresolved or failed creates. */
export function useIsProjectPendingCreation(projectId: string | null | undefined): boolean {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!client || !projectId) return () => {};
      return client.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (
          key.length === 3 &&
          key[0] === "projects" &&
          key[1] === "creation" &&
          key[2] === projectId
        )
          listener();
      });
    },
    [client, projectId],
  );
  const getSnapshot = useCallback(
    () => (client && projectId ? (readProjectCreation(client, projectId) ?? null) : null),
    [client, projectId],
  );
  const record = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return (
    !record?.accountSignal.aborted && (record?.status === "pending" || record?.status === "failed")
  );
}
