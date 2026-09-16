/**
 * Project agent definition editing route core: owner-gated save,
 * revision list, restore, and restore-original over the packages domain.
 */
import type {
  AgentDefinitionResponse,
  DefinitionRevisionListResponse,
  UpdateAgentDefinitionRequest,
} from "@meridian/contracts/agents";
import { createError } from "nitro/h3";
import {
  DefinitionEditError,
  listAgentDefinitionRevisions,
  restoreAgentDefinitionOriginal,
  restoreAgentDefinitionRevision,
  saveAgentDefinition,
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

export async function handleListAgentDefinitionRevisionsRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<DefinitionRevisionListResponse> {
  return withOwner(deps, input, () =>
    listAgentDefinitionRevisions(deps.agentRevisions, input.userId, input.slug),
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

export async function handleRestoreAgentDefinitionOriginalRequest(
  deps: ProjectDefinitionsRouteDeps,
  input: ProjectDefinitionRouteInput,
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    restoreAgentDefinitionOriginal(deps.agentRevisions, input.userId, input.slug),
  );
}
