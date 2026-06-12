/**
 * Workbench agent/skill definition editing route core: owner-gated save,
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
  getAgentDefinition,
  getSkillDefinition,
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
import type { PackageRepository } from "../domains/packages/index.js";
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchDefinitionsRouteDeps {
  workbenchRepo: WorkbenchRepository;
  packageRepository: PackageRepository;
}

export interface WorkbenchDefinitionRouteInput {
  workbenchId: string;
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
  deps: WorkbenchDefinitionsRouteDeps,
  input: Omit<WorkbenchDefinitionRouteInput, "slug">,
  fn: () => Promise<T>,
): Promise<T> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DefinitionEditError) {
      throw createError({ statusCode: 404, message: error.message });
    }
    throw error;
  }
}

export async function handleGetAgentDefinitionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction(async (tx) => {
      const agent = await getAgentDefinition(tx, input.workbenchId, input.slug);
      const record = await tx.findAgentDefinition(input.workbenchId, input.slug);
      const revisionId = record
        ? ((await tx.listAgentDefinitionRevisions(record.id)).at(0)?.id ?? "")
        : "";
      return { agent, revisionId };
    }),
  );
}

export async function handleGetSkillDefinitionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction(async (tx) => {
      const skill = await getSkillDefinition(tx, input.workbenchId, input.slug);
      const record = await tx.findSkillDefinition(input.workbenchId, input.slug);
      const revisionId = record
        ? ((await tx.listSkillDefinitionRevisions(record.id)).at(0)?.id ?? "")
        : "";
      return { skill, revisionId };
    }),
  );
}

export async function handlePutAgentDefinitionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput & { body: UpdateAgentDefinitionRequest },
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      saveAgentDefinition(tx, input.workbenchId, input.slug, input.body),
    ),
  );
}

export async function handlePutSkillDefinitionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput & { body: UpdateSkillDefinitionRequest },
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      saveSkillDefinition(tx, input.workbenchId, input.slug, input.body),
    ),
  );
}

export async function handleListAgentDefinitionRevisionsRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<DefinitionRevisionListResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      listAgentDefinitionRevisions(tx, input.workbenchId, input.slug),
    ),
  );
}

export async function handleListSkillDefinitionRevisionsRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<DefinitionRevisionListResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      listSkillDefinitionRevisions(tx, input.workbenchId, input.slug),
    ),
  );
}

export async function handleRestoreAgentDefinitionRevisionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput & { revisionId: string },
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      restoreAgentDefinitionRevision(tx, input.workbenchId, input.slug, input.revisionId),
    ),
  );
}

export async function handleRestoreSkillDefinitionRevisionRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput & { revisionId: string },
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      restoreSkillDefinitionRevision(tx, input.workbenchId, input.slug, input.revisionId),
    ),
  );
}

export async function handleRestoreAgentDefinitionOriginalRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<AgentDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      restoreAgentDefinitionOriginal(tx, input.workbenchId, input.slug),
    ),
  );
}

export async function handlePatchAgentSkillLinkRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput & { skillSlug: string; body: PatchAgentSkillLinkRequest },
): Promise<AgentDefinitionDetail> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      patchAgentSkillLink(tx, input.workbenchId, input.slug, input.skillSlug, input.body),
    ),
  );
}

export async function handleRestoreSkillDefinitionOriginalRequest(
  deps: WorkbenchDefinitionsRouteDeps,
  input: WorkbenchDefinitionRouteInput,
): Promise<SkillDefinitionResponse> {
  return withOwner(deps, input, () =>
    deps.packageRepository.transaction((tx) =>
      restoreSkillDefinitionOriginal(tx, input.workbenchId, input.slug),
    ),
  );
}
