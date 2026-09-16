/**
 * Project agent/skill definition editing route core: owner-gated save,
 * revision list, restore, and restore-original over the packages domain.
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
import { createError } from "nitro/h3";
import {
  DefinitionEditError,
  listAgentDefinitionRevisions,
  listSkillDefinitionRevisions,
  patchAgentSkillLink,
  restoreAgentDefinitionOriginal,
  restoreAgentDefinitionRevision,
  restoreSkillDefinitionOriginal,
  restoreSkillDefinitionRevision,
  saveAgentDefinition,
  saveSkillDefinition,
} from "../domains/packages/domain/definition-editing.js";
import {
  AgentConfigurationError,
  AgentPublicationConflictError,
  type AgentRevisionStore,
  AgentSourceError,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectDefinitionsRouteDeps {
  projectRepo: ProjectRepository;
  agentRevisions: AgentRevisionStore;
}

export interface ProjectDefinitionRouteInput {
  projectId: string;
  userId: string;
  slug: string;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError({ statusCode: 400, message: `${label} must be an object` });
  }
  return value as Record<string, unknown>;
}

export function parseUpdateAgentDefinitionRequest(raw: unknown): UpdateAgentDefinitionRequest {
  const body = assertObject(raw, "Request body");
  if (typeof body.body !== "string") {
    throw createError({ statusCode: 400, message: "`body` must be a string" });
  }
  const parsed: UpdateAgentDefinitionRequest = {
    body: body.body,
    meta: assertObject(body.meta, "`meta`"),
  };
  if (body.config !== undefined) {
    parsed.config = assertObject(body.config, "`config`");
  }
  return parsed;
}

export function parsePatchAgentSkillLinkRequest(raw: unknown): PatchAgentSkillLinkRequest {
  const body = assertObject(raw, "Request body");
  if (typeof body.modelInvocable !== "boolean") {
    throw createError({ statusCode: 400, message: "`modelInvocable` must be a boolean" });
  }
  return { modelInvocable: body.modelInvocable };
}

export function parseUpdateSkillDefinitionRequest(raw: unknown): UpdateSkillDefinitionRequest {
  const body = assertObject(raw, "Request body");
  if (typeof body.body !== "string") {
    throw createError({ statusCode: 400, message: "`body` must be a string" });
  }
  return {
    body: body.body,
    meta: assertObject(body.meta, "`meta`"),
  };
}

async function withOwner<T>(
  deps: ProjectDefinitionsRouteDeps,
  input: Omit<ProjectDefinitionRouteInput, "slug">,
  fn: () => Promise<T>,
): Promise<T> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DefinitionEditError) {
      throw createError({ statusCode: 404, message: error.message });
    }
    if (error instanceof AgentPublicationConflictError)
      throw createError({ statusCode: 409, message: error.message });
    if (error instanceof AgentSourceError || error instanceof AgentConfigurationError)
      throw createError({ statusCode: 422, message: error.message });
    throw error;
  }
}

export async function handlePutAgentDefinitionRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput & { body: UpdateAgentDefinitionRequest },
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    saveAgentDefinition(deps.agentRevisions, input.userId, input.slug, input.body),
  );
}

export async function handlePutSkillDefinitionRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput & { body: UpdateSkillDefinitionRequest },
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    saveSkillDefinition(deps.agentRevisions, input.userId, input.slug, input.body),
  );
}

export async function handleListAgentDefinitionRevisionsRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<DefinitionRevisionListResponse> {
  return withOwner(deps, input, () =>
    listAgentDefinitionRevisions(deps.agentRevisions, input.userId, input.slug),
  );
}

export async function handleListSkillDefinitionRevisionsRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<DefinitionRevisionListResponse> {
  return withOwner(deps, input, () =>
    listSkillDefinitionRevisions(deps.agentRevisions, input.userId, input.slug),
  );
}

export async function handleRestoreAgentDefinitionRevisionRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput & { revisionId: string },
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    restoreAgentDefinitionRevision(deps.agentRevisions, input.userId, input.slug, input.revisionId),
  );
}

export async function handleRestoreSkillDefinitionRevisionRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput & { revisionId: string },
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    restoreSkillDefinitionRevision(deps.agentRevisions, input.userId, input.slug, input.revisionId),
  );
}

export async function handleRestoreAgentDefinitionOriginalRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    restoreAgentDefinitionOriginal(deps.agentRevisions, input.userId, input.slug),
  );
}

export async function handlePatchAgentSkillLinkRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput & { skillSlug: string; body: PatchAgentSkillLinkRequest },
): Promise<AgentDefinitionDetail> {
  return withOwner(deps, input, () =>
    patchAgentSkillLink(deps.agentRevisions, input.userId, input.slug, input.skillSlug, input.body),
  );
}

export async function handleRestoreSkillDefinitionOriginalRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    restoreSkillDefinitionOriginal(deps.agentRevisions, input.userId, input.slug),
  );
}
