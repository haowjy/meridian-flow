// @ts-nocheck
/**
 * Rebind `currentAgent` on owned primary threads that have not started.
 */
import type { Thread } from "@meridian/contracts/protocol";
import type { PackageRepository } from "../domains/packages/index.js";
import type { ProjectRepository } from "../domains/projects/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepository } from "../domains/threads/ports/repositories.js";
import { AgentBindingNotFoundError } from "./thread-creation.js";

export class ThreadAlreadyStartedError extends Error {
  constructor() {
    super("Thread already started");
    this.name = "ThreadAlreadyStartedError";
  }
}

export interface RebindThreadAgentDeps {
  threads: ThreadRepository;
  projects: ProjectRepository;
  packageRepository: PackageRepository;
}

export interface RebindThreadAgentArgs {
  threadId: string;
  userId: string;
  currentAgent: string | null;
}

export async function rebindThreadAgent(
  deps: RebindThreadAgentDeps,
  args: RebindThreadAgentArgs,
): Promise<Thread> {
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    args.threadId,
    args.userId,
  );
  if (thread.kind !== "primary") {
    throw new ThreadAlreadyStartedError();
  }

  const agentSlug = args.currentAgent;
  if (agentSlug) {
    const resolved = await deps.packageRepository.getAgentWithLinkedSkills(
      thread.projectId,
      args.userId,
      agentSlug,
    );
    if (!resolved.agent) {
      throw new AgentBindingNotFoundError(agentSlug);
    }
  }

  const updated = await deps.threads.updateCurrentAgent(thread.id, agentSlug);
  if (!updated) {
    throw new ThreadAlreadyStartedError();
  }
  return updated;
}
