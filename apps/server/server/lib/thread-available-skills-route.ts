/** Route core for GET /api/threads/:threadId/skills — current available union. */
import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import type { AccountSkillInstallStore, AgentRevisionStore } from "../domains/packages/index.js";
import { resolveThreadAvailableSkills } from "../domains/runtime/loop/available-skills.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";

export interface ThreadAvailableSkillsRouteDeps {
  repos: Pick<ThreadRepositories, "threads">;
  projectRepo: Parameters<typeof requireThreadOwner>[0]["projects"];
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}

export async function handleGetThreadAvailableSkills(
  deps: ThreadAvailableSkillsRouteDeps,
  input: { threadId: string; userId: string },
): Promise<ThreadAvailableSkillsResponse> {
  const thread = await requireThreadOwner(
    { threads: deps.repos.threads, projects: deps.projectRepo },
    input.threadId,
    input.userId,
  );
  const skills = await resolveThreadAvailableSkills({
    thread,
    agentRevisions: deps.agentRevisions,
    accountSkillInstalls: deps.accountSkillInstalls,
  });
  return {
    skills: skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    })),
  };
}
