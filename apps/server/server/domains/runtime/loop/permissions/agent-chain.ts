/**
 * The delegation chain a tool call acts under (file-access §8): the calling
 * thread, its spawner, and so on up to the root, each with its own agent
 * permission and current Work. Policies take the minimum over the chain, so a
 * `read` parent caps every descendant.
 */
import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { AgentRevisionStore } from "../../../packages/index.js";
import type { WorkRepository } from "../../../projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../../../threads/index.js";

export interface AgentLink {
  threadId: ThreadId;
  permission: AgentPermission;
  /** The thread's current primary Work; follows `work switch`. */
  threadWorkId: WorkId;
  threadWorkIsNoWork: boolean;
}

/** `[calling thread, its parent, …, root]`. */
export type AgentChain = readonly AgentLink[];

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
  const seen = new Set<string>();
  let current: ThreadId | null = threadId;
  while (current !== null) {
    if (seen.has(current)) throw new Error(`Spawn lineage cycles at thread ${current}`);
    seen.add(current);
    const id: ThreadId = current;
    const [thread, binding, primary] = await Promise.all([
      deps.threads.findByIdIncludingDeleted(id),
      deps.agentRevisions.readThreadBinding(id),
      deps.threadWorks.findPrimary(id),
    ]);
    if (!thread) throw new Error(`Agent chain thread is missing: ${id}`);
    if (!binding) throw new Error(`Agent chain thread has no Agent binding: ${id}`);
    if (!primary) throw new Error(`Agent chain thread has no primary Work: ${id}`);
    const work = await deps.works.findById(primary.workId);
    if (!work) throw new Error(`Agent chain Work is missing: ${primary.workId}`);
    chain.push({
      threadId: id,
      permission: binding.configuration.permission,
      threadWorkId: primary.workId,
      threadWorkIsNoWork: work.isNoWork,
    });
    current = thread.parentThreadId as ThreadId | null;
  }
  return chain;
}
