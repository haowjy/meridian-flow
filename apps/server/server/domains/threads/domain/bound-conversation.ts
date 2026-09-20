/** Atomically establish usable conversation identity, retained execution configuration and Work membership. */
import {
  GENERIC_SUBAGENT_NAME,
  type InvocationOverlay,
  type ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { AgentRevision, AgentRevisionStore } from "../../packages/index.js";
import type { ThreadRepositories } from "../ports/repositories.js";

export async function createBoundConversation(input: {
  transaction: ThreadRepositories["transaction"];
  agentRevisions: Pick<AgentRevisionStore, "bindThread">;
  revision: AgentRevision | null;
  configuration: ResolvedAgentConfiguration;
  invocationOverlay?: InvocationOverlay | null;
  createThread(): Promise<Thread>;
  resolveWork(thread: Thread): Promise<string>;
}): Promise<Thread> {
  return input.transaction(async () => {
    const thread = await input.createThread();
    if (
      !(await input.agentRevisions.bindThread(
        thread.id,
        input.revision?.id ?? null,
        input.configuration,
        input.invocationOverlay ?? null,
      ))
    ) {
      throw new Error("Conversation Agent binding conflict");
    }
    const workId = await input.resolveWork(thread);
    return {
      ...thread,
      workId,
      agentDefinitionRevisionId: input.revision?.id ?? null,
      agentName: input.revision?.definition.metadata.name ?? GENERIC_SUBAGENT_NAME,
    };
  });
}
