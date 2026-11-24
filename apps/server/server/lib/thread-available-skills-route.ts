import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import type { AgentRevisionStore, BoundAgentCatalog } from "../domains/packages/index.js";
import { resolveThreadUserInvocableSkills } from "../domains/runtime/loop/available-skills.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";

export interface ThreadAvailableSkillsRouteDeps {
  repos: Pick<ThreadRepositories, "threads">;
  agentCatalog: Pick<BoundAgentCatalog, "userSkills">;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
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
    skills: await resolveThreadUserInvocableSkills({
      thread,
      agentCatalog: deps.agentCatalog,
      agentRevisions: deps.agentRevisions,
    }),
  };
}
