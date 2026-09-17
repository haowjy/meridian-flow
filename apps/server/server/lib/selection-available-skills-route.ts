/** Route core for GET /api/skills — user slash catalog for a selected Agent, no thread. */
import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { AccountSkillInstallStore, AgentRevisionStore } from "../domains/packages/index.js";
import { resolveSelectionUserInvocableSkills } from "../domains/runtime/loop/available-skills.js";

export interface SelectionAvailableSkillsRouteDeps {
  agentRevisions: Pick<AgentRevisionStore, "readSelection" | "listInstallations" | "readSource">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}

export async function handleGetSelectionAvailableSkills(
  deps: SelectionAvailableSkillsRouteDeps,
  input: {
    userId: string;
    catalogEntryId: string;
    definitionRevisionId: string;
    projectId?: string;
  },
): Promise<ThreadAvailableSkillsResponse> {
  const skills = await resolveSelectionUserInvocableSkills({
    userId: input.userId,
    catalogEntryId: input.catalogEntryId,
    definitionRevisionId: input.definitionRevisionId,
    projectId: input.projectId,
    agentRevisions: deps.agentRevisions,
    accountSkillInstalls: deps.accountSkillInstalls,
  });
  if (!skills) throw createError({ statusCode: 404, message: "Agent selection not found" });
  return {
    skills: skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    })),
  };
}
