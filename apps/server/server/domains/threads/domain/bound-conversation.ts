/** Atomically establish usable conversation identity, retained execution configuration and Work membership. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { AgentRevision, AgentRevisionStore } from "../../packages/index.js";
import type { ThreadRepositories } from "../ports/repositories.js";

export async function createBoundConversation(input: {
  transaction: ThreadRepositories["transaction"];
  agentRevisions: Pick<AgentRevisionStore, "bindThread">;
  revision: AgentRevision;
  configuration: ResolvedAgentConfiguration;
  createThread(): Promise<Thread>;
  resolveWork(thread: Thread): Promise<string | null>;
}): Promise<Thread> {
  return input.transaction(async () => {
    const thread = await input.createThread();
    if (
      !(await input.agentRevisions.bindThread(thread.id, input.revision.id, input.configuration))
    ) {
      throw new Error("Conversation Agent binding conflict");
    }
    const workId = await input.resolveWork(thread);
    return {
      ...thread,
      workId,
      agentDefinitionRevisionId: input.revision.id,
      agentName: input.revision.definition.metadata.name ?? input.revision.slug,
    };
  });
}
