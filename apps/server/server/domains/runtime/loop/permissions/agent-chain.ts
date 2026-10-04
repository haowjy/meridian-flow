/**
 * The delegation chain a tool call acts under (file-access §8): the calling
 * thread, its spawner, and so on up to the root, each with its own agent
 * permission and current Work. Policies take the minimum over the chain, so a
 * `read` parent caps every descendant.
 */
import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { AgentChain, AgentLink } from "../../../file-policy/index.js";
import type { AgentRevisionStore } from "../../../packages/index.js";
import type { WorkRepository } from "../../../projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../../../threads/index.js";

export type { AgentChain, AgentLink };

export interface AgentChainDeps {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
}

/**
 * Reads every link's binding and Work fresh. Call it per tool call, never from
 * a turn-cached context: a rebind or a parent's switch must show up on the
 * next call. A trashed ancestor still caps its descendants.
 */
export async function readAgentChain(
  deps: AgentChainDeps,
  threadId: ThreadId,
): Promise<AgentChain> {
  const chain: AgentLink[] = [];
  for await (const { id, permission } of lineage(deps, threadId)) {
    const primary = await deps.threadWorks.findPrimary(id);
    if (!primary) throw new Error(`Agent chain thread has no primary Work: ${id}`);
    const work = await deps.works.findById(primary.workId);
    if (!work) throw new Error(`Agent chain Work is missing: ${primary.workId}`);
    chain.push({
      threadId: id,
      permission,
      threadWorkId: primary.workId,
      threadWorkIsNoWork: work.isNoWork,
    });
  }
  return chain;
}

/**
 * The lowest permission over the chain: an `edit` child under a `read` parent
 * is effectively `read` outside its own scratch.
 */
export async function readChainPermission(
  deps: Pick<AgentChainDeps, "threads" | "agentRevisions">,
  threadId: ThreadId,
): Promise<AgentPermission> {
  for await (const link of lineage(deps, threadId)) {
    if (link.permission === "read") return "read";
  }
  return "edit";
}

/** The thread, then each spawner up to the root, with its bound permission. */
async function* lineage(
  deps: Pick<AgentChainDeps, "threads" | "agentRevisions">,
  threadId: ThreadId,
): AsyncGenerator<{ id: ThreadId; permission: AgentPermission }> {
  const seen = new Set<string>();
  let current: ThreadId | null = threadId;
  while (current !== null) {
    if (seen.has(current)) throw new Error(`Spawn lineage cycles at thread ${current}`);
    seen.add(current);
    const id: ThreadId = current;
    const [thread, binding] = await Promise.all([
      deps.threads.findByIdIncludingDeleted(id),
      deps.agentRevisions.readThreadBinding(id),
    ]);
    if (!thread) throw new Error(`Agent chain thread is missing: ${id}`);
    if (!binding) throw new Error(`Agent chain thread has no Agent binding: ${id}`);
    yield { id, permission: binding.configuration.permission };
    current = thread.parentThreadId as ThreadId | null;
  }
}
