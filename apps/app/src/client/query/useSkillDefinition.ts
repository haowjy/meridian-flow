// @ts-nocheck
/**
 * useSkillDefinition — React Query hooks for Library skill definition editing.
 *
 * Mirrors the agent definition hooks: load, save, revision history, restore.
 * Mutations invalidate library inventory so Edited badges update after save.
 */

import type {
  DefinitionRevisionListResponse,
  SkillDefinitionResponse,
  UpdateSkillDefinitionRequest,
} from "@meridian/contracts/agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getSkillDefinition,
  listSkillDefinitionRevisions,
  restoreSkillDefinitionOriginal,
  restoreSkillDefinitionRevision,
  updateSkillDefinition,
} from "@/client/api/project-definitions-api";

import { projectQueryKeys } from "./project-query-keys";

export function useSkillDefinition(projectId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.skillDefinition(projectId, slug),
    queryFn: () => getSkillDefinition(projectId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(projectId && slug),
  });
}

export function useSkillDefinitionRevisions(projectId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.skillDefinitionRevisions(projectId, slug),
    queryFn: () => listSkillDefinitionRevisions(projectId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(projectId && slug),
  });
}

function patchSkillDefinitionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  slug: string,
  response: SkillDefinitionResponse,
) {
  const definitionKey = projectQueryKeys.skillDefinition(projectId, slug);
  queryClient.setQueryData(definitionKey, response);
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.library(projectId) });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.skillDefinitionRevisions(projectId, slug),
  });
}

export function useUpdateSkillDefinition(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSkillDefinitionRequest) =>
      updateSkillDefinition(projectId, slug, body),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export function useRestoreSkillDefinitionRevision(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) => restoreSkillDefinitionRevision(projectId, slug, revisionId),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export function useRestoreSkillDefinitionOriginal(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restoreSkillDefinitionOriginal(projectId, slug),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export type SkillDefinitionRevisionsStatus = {
  revisions: DefinitionRevisionListResponse["revisions"] | null;
  status: "loading" | "ready" | "error";
};

export function useSkillDefinitionRevisionsStatus(
  projectId: string,
  slug: string,
  open: boolean,
): SkillDefinitionRevisionsStatus {
  const { data, isError, isPending } = useSkillDefinitionRevisions(projectId, slug, open);
  return {
    revisions: data?.revisions ?? null,
    status: isError ? "error" : isPending ? "loading" : "ready",
  };
}
