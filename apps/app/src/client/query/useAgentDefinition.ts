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
  ProjectLibraryResponse,
  UpdateAgentDefinitionRequest,
} from "@meridian/contracts/agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getAgentDefinition,
  listAgentDefinitionRevisions,
  patchAgentSkillLink,
  restoreAgentDefinitionOriginal,
  restoreAgentDefinitionRevision,
  updateAgentDefinition,
} from "@/client/api/project-definitions-api";

import { projectQueryKeys } from "./project-query-keys";

export function useAgentDefinition(projectId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.agentDefinition(projectId, slug),
    queryFn: () => getAgentDefinition(projectId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(projectId && slug),
  });
}

export function useAgentDefinitionRevisions(projectId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: projectQueryKeys.agentDefinitionRevisions(projectId, slug),
    queryFn: () => listAgentDefinitionRevisions(projectId, slug),
    staleTime: 30_000,
    enabled: enabled && Boolean(projectId && slug),
  });
}

function patchLibraryEditedFlag(
  library: ProjectLibraryResponse | undefined,
  slug: string,
  isEdited: boolean,
  description?: string,
): ProjectLibraryResponse | undefined {
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
  projectId: string,
  slug: string,
  response: AgentDefinitionResponse,
) {
  const definitionKey = projectQueryKeys.agentDefinition(projectId, slug);
  queryClient.setQueryData(definitionKey, response);
  const libraryKey = projectQueryKeys.library(projectId);
  queryClient.setQueryData(libraryKey, (current) =>
    patchLibraryEditedFlag(
      current as ProjectLibraryResponse | undefined,
      slug,
      response.agent.isEdited,
      typeof response.agent.meta.description === "string"
        ? response.agent.meta.description
        : undefined,
    ),
  );
  void queryClient.invalidateQueries({ queryKey: libraryKey });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.agentDefinitionRevisions(projectId, slug),
  });
}

function patchAgentDetailCache(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  slug: string,
  agent: AgentDefinitionDetail,
) {
  const definitionKey = projectQueryKeys.agentDefinition(projectId, slug);
  queryClient.setQueryData(definitionKey, (current) => {
    const revisionId =
      current && typeof current === "object" && "revisionId" in current
        ? (current as AgentDefinitionResponse).revisionId
        : "";
    return { agent, revisionId };
  });
}

export function useUpdateAgentDefinition(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAgentDefinitionRequest) =>
      updateAgentDefinition(projectId, slug, body),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export function useRestoreAgentDefinitionRevision(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) => restoreAgentDefinitionRevision(projectId, slug, revisionId),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export function usePatchAgentSkillLink(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PatchAgentSkillLinkRequest & { skillSlug: string }) =>
      patchAgentSkillLink(projectId, slug, input.skillSlug, {
        modelInvocable: input.modelInvocable,
      }),
    onSuccess: (agent) => {
      patchAgentDetailCache(queryClient, projectId, slug, agent);
    },
  });
}

export function useRestoreAgentDefinitionOriginal(projectId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restoreAgentDefinitionOriginal(projectId, slug),
    onSuccess: (response) => {
      patchAgentDefinitionCaches(queryClient, projectId, slug, response);
    },
  });
}

export type AgentDefinitionRevisionsStatus = {
  revisions: DefinitionRevisionListResponse["revisions"] | null;
  status: "loading" | "ready" | "error";
};

export function useAgentDefinitionRevisionsStatus(
  projectId: string,
  slug: string,
  open: boolean,
): AgentDefinitionRevisionsStatus {
  const { data, isError, isPending } = useAgentDefinitionRevisions(projectId, slug, open);
  return {
    revisions: data?.revisions ?? null,
    status: isError ? "error" : isPending ? "loading" : "ready",
  };
}
