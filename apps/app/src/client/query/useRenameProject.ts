/**
 * useRenameProject — the project title rename command. The title shows at
 * once; a refusal reverts to the last confirmed title, but only when no newer
 * rename has started since, so an older failure never rolls back over a newer
 * pending or confirmed title. The returned `rename` rejects only for the latest
 * rename's refusal, the one a `TitleEditSlot` should reopen.
 */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { updateProject } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

type RenameVariables = { title: string; revision: number };

type RenameRecord = {
  /** Revision of the latest rename started. */
  revision: number;
  /** Renames not yet settled. */
  pending: number;
  /** The last confirmed title; what the latest rename's refusal reverts to. */
  confirmed: string;
};

/** Titles of project renames still on their way, the latest per project. */
export function pendingProjectTitles(client: QueryClient): Map<string, string> {
  const titles = new Map<string, string>();
  for (const mutation of client
    .getMutationCache()
    .findAll({ mutationKey: projectQueryKeys.renamePrefix, status: "pending" })) {
    const projectId = mutation.options.mutationKey?.[2];
    const variables = mutation.state.variables as RenameVariables | undefined;
    if (typeof projectId === "string" && variables) titles.set(projectId, variables.title);
  }
  return titles;
}

export function useRenameProject(project: Project): (title: string) => Promise<void> {
  const queryClient = useQueryClient();
  const projectId = project.id;
  const record = useRef<RenameRecord>({ revision: 0, pending: 0, confirmed: project.title });
  const fallback = useRef(project);
  fallback.current = project;

  const mutation = useMutation({
    mutationKey: projectQueryKeys.rename(projectId),
    mutationFn: ({ title }: RenameVariables) => updateProject(projectId, { title }),
    onMutate: async ({ title }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: projectQueryKeys.list }),
        queryClient.cancelQueries({ queryKey: projectQueryKeys.detail(projectId) }),
      ]);
      showTitle(queryClient, fallback.current, title);
    },
    onError: (_error, { revision }) => {
      record.current.pending -= 1;
      if (revision === record.current.revision)
        showTitle(queryClient, fallback.current, record.current.confirmed);
    },
    onSuccess: async (confirmed, { revision }) => {
      record.current.pending -= 1;
      record.current.confirmed = confirmed.title;
      if (revision !== record.current.revision) return;
      // A list read started while the mutation was pending may return an old
      // title after PATCH succeeds. Fence it before publishing confirmation.
      await queryClient.cancelQueries({ queryKey: projectQueryKeys.list });
      queryClient.setQueryData<Project[] | null>(projectQueryKeys.list, (list) =>
        list?.map((item) => (item.id === confirmed.id ? confirmed : item)),
      );
      queryClient.setQueryData(projectQueryKeys.detail(projectId), confirmed);
    },
  });

  const { mutateAsync } = mutation;
  return useCallback(
    async (title: string) => {
      const current = record.current;
      if (current.pending === 0)
        current.confirmed = readTitle(queryClient, projectId) ?? current.confirmed;
      current.pending += 1;
      const revision = ++current.revision;
      try {
        await mutateAsync({ title, revision });
      } catch (error) {
        // A newer rename owns the title now; this refusal has nothing to reopen.
        if (revision === record.current.revision) throw error;
      }
    },
    [mutateAsync, projectId, queryClient],
  );
}

function readTitle(client: QueryClient, projectId: string): string | undefined {
  return (
    client.getQueryData<Project>(projectQueryKeys.detail(projectId)) ??
    client
      .getQueryData<Project[] | null>(projectQueryKeys.list)
      ?.find((row) => row.id === projectId)
  )?.title;
}

function showTitle(client: QueryClient, project: Project, title: string): void {
  const retitle = (row: Project): Project => ({ ...row, title });
  client.setQueryData<Project[] | null>(projectQueryKeys.list, (current) =>
    (current ?? [project]).map((row) => (row.id === project.id ? retitle(row) : row)),
  );
  client.setQueryData<Project>(projectQueryKeys.detail(project.id), (detail) =>
    detail ? retitle(detail) : detail,
  );
}
