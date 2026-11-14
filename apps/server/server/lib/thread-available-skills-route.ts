/** Route core for GET /api/threads/:threadId/skills — user slash catalog. */
import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import type { BoundAgentCatalog } from "../domains/packages/index.js";
import { resolveThreadUserInvocableSkills } from "../domains/runtime/loop/available-skills.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";

export interface ThreadAvailableSkillsRouteDeps {
  repos: Pick<ThreadRepositories, "threads">;
  agentCatalog: Pick<BoundAgentCatalog, "userSkills">;
}

export async function handleGetThreadAvailableSkills(
  deps: ThreadAvailableSkillsRouteDeps,
  input: { threadId: string; userId: string },
): Promise<ThreadAvailableSkillsResponse> {
  const thread = await requireThreadOwner(
    { threads: deps.repos.threads },
    input.threadId,
    input.userId,
  );
  return {
    skills: await resolveThreadUserInvocableSkills({ thread, agentCatalog: deps.agentCatalog }),
  };
}
