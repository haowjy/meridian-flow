// @ts-nocheck
/**
 * workbench-definitions-api — typed HTTP client for Library agent/skill editing.
 *
 * Backed by workbench-scoped definition routes: load, save, revision history,
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

export function workbenchAgentDefinitionPath(workbenchId: string, slug: string): string {
  return `/api/workbenches/${workbenchId}/agents/${slug}`;
}

export function workbenchSkillDefinitionPath(workbenchId: string, slug: string): string {
  return `/api/workbenches/${workbenchId}/skills/${slug}`;
}

function agentRevisionsPath(workbenchId: string, slug: string): string {
  return `${workbenchAgentDefinitionPath(workbenchId, slug)}/revisions`;
}

function skillRevisionsPath(workbenchId: string, slug: string): string {
  return `${workbenchSkillDefinitionPath(workbenchId, slug)}/revisions`;
}

export async function getAgentDefinition(
  workbenchId: string,
  slug: string,
): Promise<AgentDefinitionResponse> {
  return getJson<AgentDefinitionResponse>(workbenchAgentDefinitionPath(workbenchId, slug));
}

export async function updateAgentDefinition(
  workbenchId: string,
  slug: string,
  body: UpdateAgentDefinitionRequest,
): Promise<AgentDefinitionResponse> {
  return putJson<AgentDefinitionResponse>(workbenchAgentDefinitionPath(workbenchId, slug), body);
}

export async function listAgentDefinitionRevisions(
  workbenchId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  return getJson<DefinitionRevisionListResponse>(agentRevisionsPath(workbenchId, slug));
}

export async function restoreAgentDefinitionRevision(
  workbenchId: string,
  slug: string,
  revisionId: string,
): Promise<AgentDefinitionResponse> {
  return postJson<AgentDefinitionResponse>(
    `${agentRevisionsPath(workbenchId, slug)}/${revisionId}/restore`,
    {},
  );
}

export function workbenchAgentSkillLinkPath(
  workbenchId: string,
  agentSlug: string,
  skillSlug: string,
): string {
  return `${workbenchAgentDefinitionPath(workbenchId, agentSlug)}/skills/${skillSlug}`;
}

export async function patchAgentSkillLink(
  workbenchId: string,
  agentSlug: string,
  skillSlug: string,
  body: PatchAgentSkillLinkRequest,
): Promise<AgentDefinitionDetail> {
  return patchJson<AgentDefinitionDetail>(
    workbenchAgentSkillLinkPath(workbenchId, agentSlug, skillSlug),
    body,
  );
}

export async function restoreAgentDefinitionOriginal(
  workbenchId: string,
  slug: string,
): Promise<AgentDefinitionResponse> {
  return postJson<AgentDefinitionResponse>(
    `${workbenchAgentDefinitionPath(workbenchId, slug)}/restore-original`,
    {},
  );
}

export async function getSkillDefinition(
  workbenchId: string,
  slug: string,
): Promise<SkillDefinitionResponse> {
  return getJson<SkillDefinitionResponse>(workbenchSkillDefinitionPath(workbenchId, slug));
}

export async function updateSkillDefinition(
  workbenchId: string,
  slug: string,
  body: UpdateSkillDefinitionRequest,
): Promise<SkillDefinitionResponse> {
  return putJson<SkillDefinitionResponse>(workbenchSkillDefinitionPath(workbenchId, slug), body);
}

export async function listSkillDefinitionRevisions(
  workbenchId: string,
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  return getJson<DefinitionRevisionListResponse>(skillRevisionsPath(workbenchId, slug));
}

export async function restoreSkillDefinitionRevision(
  workbenchId: string,
  slug: string,
  revisionId: string,
): Promise<SkillDefinitionResponse> {
  return postJson<SkillDefinitionResponse>(
    `${skillRevisionsPath(workbenchId, slug)}/${revisionId}/restore`,
    {},
  );
}

export async function restoreSkillDefinitionOriginal(
  workbenchId: string,
  slug: string,
): Promise<SkillDefinitionResponse> {
  return postJson<SkillDefinitionResponse>(
    `${workbenchSkillDefinitionPath(workbenchId, slug)}/restore-original`,
    {},
  );
}
