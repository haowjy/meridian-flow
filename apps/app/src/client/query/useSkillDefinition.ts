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
} from "@/client/api/workbench-definitions-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

export function useSkillDefinition(workbenchId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: workbenchQueryKeys.skillDefinition(workbenchId, slug),
    queryFn: () => getSkillDefinition(workbenchId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(workbenchId && slug),
  });
}

export function useSkillDefinitionRevisions(workbenchId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: workbenchQueryKeys.skillDefinitionRevisions(workbenchId, slug),
    queryFn: () => listSkillDefinitionRevisions(workbenchId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(workbenchId && slug),
  });
}

function patchSkillDefinitionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  workbenchId: string,
  slug: string,
  response: SkillDefinitionResponse,
) {
  const definitionKey = workbenchQueryKeys.skillDefinition(workbenchId, slug);
  queryClient.setQueryData(definitionKey, response);
  void queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.library(workbenchId) });
  void queryClient.invalidateQueries({
    queryKey: workbenchQueryKeys.skillDefinitionRevisions(workbenchId, slug),
  });
}

export function useUpdateSkillDefinition(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSkillDefinitionRequest) =>
      updateSkillDefinition(workbenchId, slug, body),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export function useRestoreSkillDefinitionRevision(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      restoreSkillDefinitionRevision(workbenchId, slug, revisionId),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export function useRestoreSkillDefinitionOriginal(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restoreSkillDefinitionOriginal(workbenchId, slug),
    onSuccess: (response) => {
      patchSkillDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export type SkillDefinitionRevisionsStatus = {
  revisions: DefinitionRevisionListResponse["revisions"] | null;
  status: "loading" | "ready" | "error";
};

export function useSkillDefinitionRevisionsStatus(
  workbenchId: string,
  slug: string,
  open: boolean,
): SkillDefinitionRevisionsStatus {
  const { data, isError, isPending } = useSkillDefinitionRevisions(workbenchId, slug, open);
  return {
    revisions: data?.revisions ?? null,
    status: isError ? "error" : isPending ? "loading" : "ready",
  };
}
