// @ts-nocheck
/**
 * Agent-linked skill catalogue support.
 *
 * Meridian does not run package skills in a hosted execution environment.
 * This module preserves Meridian Flow's baked skill-catalog architecture for prompt
 * assembly and dispatcher registration while making executable skill invokes a
 * deliberate no-op boundary.
 */
import type { PackageRepository, ResolvedSkill } from "../../packages/index.js";
import type { FunctionTool } from "../gateway/index.js";
import type { ToolHandler, ToolRegistration } from "./types.js";

export const INVOKE_TOOL_NAME = "invoke";
/** Stable substring rendered into the skills-catalog section at bake time. */
export const SKILLS_CATALOG_PROMPT_MARKER = "Available skills (call invoke with the skill name):";

export interface InvokeToolDeps {
  packageRepository: PackageRepository;
  findThreadById(threadId: string): Promise<{
    projectId: string;
    userId: string;
    currentAgent: string | null;
    bakedSkillSlugs: string[] | null;
  } | null>;
}

/** Sorted slugs of model-invocable skills — the bake-time skill contract. */
export function modelInvocableSkillSlugs(resolvedSkills: ResolvedSkill[]): string[] {
  return resolvedSkills
    .filter((resolved) => resolved.modelInvocable)
    .map((resolved) => resolved.skill.slug)
    .sort((left, right) => left.localeCompare(right));
}

/** Intersection of baked slugs and currently model-invocable skills (error listings). */
export function invokeAvailableSkillSlugs(
  bakedSkillSlugs: string[] | null | undefined,
  resolvedSkills: ResolvedSkill[],
): string[] {
  const baked = new Set(bakedSkillSlugs ?? []);
  return modelInvocableSkillSlugs(resolvedSkills).filter((slug) => baked.has(slug));
}

function formatAvailableSkillsList(slugs: string[]): string {
  return slugs.length > 0 ? slugs.join(", ") : "(none)";
}

export function createInvokeToolRegistration(deps: InvokeToolDeps): ToolRegistration {
  const handler: ToolHandler = async (input, ctx) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const skillname = raw.skillname;
    if (typeof skillname !== "string" || skillname.length === 0) {
      return { isError: true, output: "invoke requires skillname (string)." };
    }

    const thread = await deps.findThreadById(ctx.threadId);
    if (!thread) {
      return { isError: true, output: `Thread not found: ${ctx.threadId}` };
    }
    if (!thread.currentAgent) {
      return { isError: true, output: "Thread has no agent-bound skill context." };
    }
    if (thread.bakedSkillSlugs === null || thread.bakedSkillSlugs === undefined) {
      return { isError: true, output: "Thread skill catalog is not baked yet." };
    }

    const packageContext = await deps.packageRepository.getAgentWithLinkedSkills(
      thread.projectId,
      thread.userId,
      thread.currentAgent,
    );
    const bakedSlugs = new Set(thread.bakedSkillSlugs);
    const availableSlugs = invokeAvailableSkillSlugs(thread.bakedSkillSlugs, packageContext.skills);

    if (!bakedSlugs.has(skillname)) {
      return {
        isError: true,
        output: `Unknown skill "${skillname}". Available skills: ${formatAvailableSkillsList(availableSlugs)}`,
      };
    }

    const resolved = packageContext.skills
      .filter((skill) => skill.modelInvocable)
      .find((candidate) => candidate.skill.slug === skillname);
    if (!resolved) {
      return {
        isError: true,
        output: `Skill "${skillname}" is no longer available. Available skills: ${formatAvailableSkillsList(availableSlugs)}`,
      };
    }

    return {
      isError: true,
      output: `Skill "${skillname}" is available as prompt context, but executable skill runtime is disabled in Meridian.`,
    };
  };

  return {
    source: "skill",
    definition: invokeFunctionToolDefinition(),
    execution: { type: "server", handler },
    sequential: true,
    advertise: false,
    timeoutMs: 30_000,
  };
}

export function invokeFunctionToolDefinition(): FunctionTool {
  return {
    type: "function",
    name: INVOKE_TOOL_NAME,
    description: "Reference an agent-linked package skill by slug.",
    inputSchema: {
      type: "object",
      properties: {
        skillname: { type: "string", description: "Slug of the skill to reference" },
      },
      required: ["skillname"],
      additionalProperties: false,
    },
  };
}

/**
 * Compact, deterministic catalog for the system prompt. Only model-invocable
 * skills are listed; slugs are sorted for stable ordering across turns.
 */
export function renderSkillsSystemPromptSection(
  resolvedSkills: ResolvedSkill[],
): string | undefined {
  const invocable = resolvedSkills
    .filter((resolved) => resolved.modelInvocable)
    .sort((left, right) => left.skill.slug.localeCompare(right.skill.slug));
  if (invocable.length === 0) return undefined;

  const entries = invocable.map((resolved) => {
    const description =
      typeof resolved.skill.meta.description === "string" ? resolved.skill.meta.description : "";
    return `- ${resolved.skill.slug}: ${description}`;
  });

  return ["---", SKILLS_CATALOG_PROMPT_MARKER, ...entries, "---"].join("\n");
}
