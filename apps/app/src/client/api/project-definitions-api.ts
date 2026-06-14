// @ts-nocheck
/**
 * project-definitions-api — typed HTTP client for Library agent/skill editing.
 *
 * Backed by project-scoped definition routes: load, save, revision history,
 * restore-from-revision, and restore-original. Response shapes come from
 * `@meridian/contracts/agents`.
 */
import type {
  AgentDefinitionDetail,
  AgentDefinitionResponse,
  DefinitionRevisionListResponse,
  PatchAgentSkillLinkRequest,
  SkillDefinitionResponse,
  UpdateAgentDefinitionRequest,
  UpdateSkillDefinitionRequest,
} from "@meridian/contracts/agents";

import { getJson, patchJson, postJson, putJson } from "./http-client";

export function projectAgentDefinitionPath(projectId: string, slug: string): string {
  return `/api/projects/${projectId}/agents/${slug}`;
}

export function projectSkillDefinitionPath(projectId: string, slug: string): string {
  return `/api/projects/${projectId}/skills/${slug}`;
}

function agentRevisionsPath(projectId: string, slug: string): string {
  return `${projectAgentDefinitionPath(projectId, slug)}/revisions`;
}

function skillRevisionsPath(projectId: string, slug: string): string {
  return `${projectSkillDefinitionPath(projectId, slug)}/revisions`;
}

export async function getAgentDefinition(
  projectId: string,
  slug: string,
): Promise<AgentDefinitionResponse> {
  return getJson<AgentDefinitionResponse>(projectAgentDefinitionPath(projectId, slug));
}

export async function updateAgentDefinition(
  projectId: string,
  slug: string,
  body: UpdateAgentDefinitionRequest,
): Promise<AgentDefinitionResponse> {
  return putJson<AgentDefinitionResponse>(projectAgentDefinitionPath(projectId, slug), body);
}

export async function listAgentDefinitionRevisions(
  projectId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  return getJson<DefinitionRevisionListResponse>(agentRevisionsPath(projectId, slug));
}

export async function restoreAgentDefinitionRevision(
  projectId: string,
  slug: string,
  revisionId: string,
): Promise<AgentDefinitionResponse> {
  return postJson<AgentDefinitionResponse>(
    `${agentRevisionsPath(projectId, slug)}/${revisionId}/restore`,
    {},
  );
}

export function projectAgentSkillLinkPath(
  projectId: string,
  agentSlug: string,
  skillSlug: string,
): string {
  return `${projectAgentDefinitionPath(projectId, agentSlug)}/skills/${skillSlug}`;
}

export async function patchAgentSkillLink(
  projectId: string,
  agentSlug: string,
  skillSlug: string,
  body: PatchAgentSkillLinkRequest,
): Promise<AgentDefinitionDetail> {
  return patchJson<AgentDefinitionDetail>(
    projectAgentSkillLinkPath(projectId, agentSlug, skillSlug),
    body,
  );
}

export async function restoreAgentDefinitionOriginal(
  projectId: string,
  slug: string,
): Promise<AgentDefinitionResponse> {
  return postJson<AgentDefinitionResponse>(
    `${projectAgentDefinitionPath(projectId, slug)}/restore-original`,
    {},
  );
}

export async function getSkillDefinition(
  projectId: string,
  slug: string,
): Promise<SkillDefinitionResponse> {
  return getJson<SkillDefinitionResponse>(projectSkillDefinitionPath(projectId, slug));
}

export async function updateSkillDefinition(
  projectId: string,
  slug: string,
  body: UpdateSkillDefinitionRequest,
): Promise<SkillDefinitionResponse> {
  return putJson<SkillDefinitionResponse>(projectSkillDefinitionPath(projectId, slug), body);
}

export async function listSkillDefinitionRevisions(
  projectId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  return getJson<DefinitionRevisionListResponse>(skillRevisionsPath(projectId, slug));
}

export async function restoreSkillDefinitionRevision(
  projectId: string,
  slug: string,
  revisionId: string,
): Promise<SkillDefinitionResponse> {
  return postJson<SkillDefinitionResponse>(
    `${skillRevisionsPath(projectId, slug)}/${revisionId}/restore`,
    {},
  );
}

export async function restoreSkillDefinitionOriginal(
  projectId: string,
  slug: string,
): Promise<SkillDefinitionResponse> {
  return postJson<SkillDefinitionResponse>(
    `${projectSkillDefinitionPath(projectId, slug)}/restore-original`,
    {},
  );
}
