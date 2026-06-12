// @ts-nocheck
/**
 * useAgentDefinition — React Query hooks for Library agent definition editing.
 *
 * Loads full definition detail, saves explicit revisions, lists history, and
 * restores from a revision or the pristine package copy. Mutations invalidate
 * the definition, revision list, and library inventory so Edited badges stay
 * in sync.
 */

import type {
  AgentDefinitionDetail,
  AgentDefinitionResponse,
  DefinitionRevisionListResponse,
  PatchAgentSkillLinkRequest,
  UpdateAgentDefinitionRequest,
  WorkbenchLibraryResponse,
} from "@meridian/contracts/agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getAgentDefinition,
  listAgentDefinitionRevisions,
  patchAgentSkillLink,
  restoreAgentDefinitionOriginal,
  restoreAgentDefinitionRevision,
  updateAgentDefinition,
} from "@/client/api/workbench-definitions-api";

import { workbenchQueryKeys } from "./workbench-query-keys";

export function useAgentDefinition(workbenchId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: workbenchQueryKeys.agentDefinition(workbenchId, slug),
    queryFn: () => getAgentDefinition(workbenchId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(workbenchId && slug),
  });
}

export function useAgentDefinitionRevisions(workbenchId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: workbenchQueryKeys.agentDefinitionRevisions(workbenchId, slug),
    queryFn: () => listAgentDefinitionRevisions(workbenchId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(workbenchId && slug),
  });
}

function patchLibraryEditedFlag(
  library: WorkbenchLibraryResponse | undefined,
  slug: string,
  isEdited: boolean,
  description?: string,
): WorkbenchLibraryResponse | undefined {
  if (!library) return library;
  return {
    ...library,
    agents: library.agents.map((agent) =>
      agent.slug === slug
        ? {
            ...agent,
            isEdited,
            ...(description !== undefined ? { description } : {}),
          }
        : agent,
    ),
  };
}

function patchAgentDefinitionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  workbenchId: string,
  slug: string,
  response: AgentDefinitionResponse,
) {
  const definitionKey = workbenchQueryKeys.agentDefinition(workbenchId, slug);
  queryClient.setQueryData(definitionKey, response);
  const libraryKey = workbenchQueryKeys.library(workbenchId);
  queryClient.setQueryData(libraryKey, (current) =>
    patchLibraryEditedFlag(
      current as WorkbenchLibraryResponse | undefined,
      slug,
      response.agent.isEdited,
      typeof response.agent.meta.description === "string"
        ? response.agent.meta.description
        : undefined,
    ),
  );
  void queryClient.invalidateQueries({ queryKey: libraryKey });
  void queryClient.invalidateQueries({
    queryKey: workbenchQueryKeys.agentDefinitionRevisions(workbenchId, slug),
  });
}

function patchAgentDetailCache(
  queryClient: ReturnType<typeof useQueryClient>,
  workbenchId: string,
  slug: string,
  agent: AgentDefinitionDetail,
) {
  const definitionKey = workbenchQueryKeys.agentDefinition(workbenchId, slug);
  queryClient.setQueryData(definitionKey, (current) => {
    const revisionId =
      current && typeof current === "object" && "revisionId" in current
        ? (current as AgentDefinitionResponse).revisionId
        : "";
    return { agent, revisionId };
  });
}

export function useUpdateAgentDefinition(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAgentDefinitionRequest) =>
      updateAgentDefinition(workbenchId, slug, body),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export function useRestoreAgentDefinitionRevision(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      restoreAgentDefinitionRevision(workbenchId, slug, revisionId),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export function usePatchAgentSkillLink(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PatchAgentSkillLinkRequest & { skillSlug: string }) =>
      patchAgentSkillLink(workbenchId, slug, input.skillSlug, {
        modelInvocable: input.modelInvocable,
      }),
    onSuccess: (agent) => {
      patchAgentDetailCache(queryClient, workbenchId, slug, agent);
    },
  });
}

export function useRestoreAgentDefinitionOriginal(workbenchId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restoreAgentDefinitionOriginal(workbenchId, slug),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, workbenchId, slug, response);
    },
  });
}

export type AgentDefinitionRevisionsStatus = {
  revisions: DefinitionRevisionListResponse["revisions"] | null;
  status: "loading" | "ready" | "error";
};

export function useAgentDefinitionRevisionsStatus(
  workbenchId: string,
  slug: string,
  open: boolean,
): AgentDefinitionRevisionsStatus {
  const { data, isError, isPending } = useAgentDefinitionRevisions(workbenchId, slug, open);
  return {
    revisions: data?.revisions ?? null,
    status: isError ? "error" : isPending ? "loading" : "ready",
  };
}
