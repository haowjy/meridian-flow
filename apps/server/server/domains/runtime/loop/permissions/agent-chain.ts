import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId } from "@meridian/contracts/runtime";
import { scratchOwnerFor } from "../../../context/index.js";
import type { AgentChain, AgentLink } from "../../../file-policy/index.js";
import type { AgentRevisionStore } from "../../../packages/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../../../threads/index.js";

export type { AgentChain, AgentLink };

interface AgentChainDeps {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<import("../../../projects/index.js").WorkRepository, "findById">;
}

export async function readAgentChain(
  deps: AgentChainDeps,
  threadId: ThreadId,
): Promise<AgentChain> {
  const chain: AgentLink[] = [];
  for (const { threadId: id, permission } of await readLineage(deps, threadId)) {
    const primary = await deps.threadWorks.findPrimary(id);
    if (!primary) throw new Error(`Agent chain thread has no primary Work: ${id}`);
    const [thread, work] = await Promise.all([
      deps.threads.findByIdIncludingDeleted(id),
      deps.works.findById(primary.workId),
    ]);
    if (!thread || !work) throw new Error("Scratch owner is unavailable");
    chain.push({
      threadId: id,
      permission,
      threadWorkId: primary.workId,
      scratchOwner: scratchOwnerFor(thread, work),
    });
  }
  return chain;
}

export function chainPermission(chain: readonly Pick<AgentLink, "permission">[]): AgentPermission {
  return chain.some((link) => link.permission === "read") ? "read" : "edit";
}

export async function readChainPermission(
  deps: Pick<AgentChainDeps, "threads" | "agentRevisions">,
  threadId: ThreadId,
): Promise<AgentPermission> {
  return chainPermission(await readLineage(deps, threadId));
}

type LineageLink = Pick<AgentLink, "threadId" | "permission">;

async function readLineage(
  deps: Pick<AgentChainDeps, "threads" | "agentRevisions">,
  threadId: ThreadId,
): Promise<LineageLink[]> {
  const links: LineageLink[] = [];
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
    links.push({ threadId: id, permission: binding.configuration.permission });
    current = thread.parentThreadId as ThreadId | null;
  }
  return links;
}
