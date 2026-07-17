/**
 * Thread-creation orchestration helper: creates a thread for a project after
 * asserting ownership and resolving its work attachment. App-layer glue tying
 * the projects + threads + packages domains together.
 */
import type { Thread } from "@meridian/contracts/protocol";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { PackageRepository } from "../domains/packages/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { ThreadRepositories } from "./compose.js";
import { resolveWorkMembership } from "./work-attachment.js";

export { InvalidWorkAttachmentError } from "./work-attachment.js";

export class AgentBindingNotFoundError extends Error {
  constructor(public readonly agentSlug: string) {
    super(`Agent not found: ${agentSlug}`);
    this.name = "AgentBindingNotFoundError";
  }
}

export interface CreateThreadForProjectDeps {
  projects: ProjectRepository;
  workRepo: WorkRepository;
  threads: ThreadRepositories["threads"];
  threadWorks: ThreadRepositories["threadWorks"];
  transaction: ThreadRepositories["transaction"];
  packageRepository?: PackageRepository;
  eventSink: EventSink;
}

export interface CreateThreadForProjectArgs {
  projectId: string;
  userId: string;
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  title?: string | null;
  systemPrompt?: string | null;
  /** Mars agent slug — when set, agent body becomes the thread system prompt. */
  currentAgent?: string | null;
  /** Explicit work assignment from the request, if any. */
  workId?: string | null;
  /** When set, this is a subagent thread — inherit the parent's work. */
  parentThreadId?: string | null;
}

/**
 * Create a thread under a project — the single owner of thread-creation policy
 * shared by both the global (`/api/threads`) and project-scoped
 * (`/api/projects/:projectId/threads`) routes. Verifies ownership, persists the
 * thread row, then creates its primary Work membership. Throws (404) if the caller
 * does not own the project.
 */
export async function createThreadForProject(
  deps: CreateThreadForProjectDeps,
  args: CreateThreadForProjectArgs,
): Promise<Thread> {
  const eventSink = deps.eventSink;
  const project = await requireProjectOwner(
    { projects: deps.projects },
    args.projectId,
    args.userId,
  );

  const agentSlug = args.currentAgent ?? null;
  if (agentSlug) {
    if (!deps.packageRepository) {
      throw new Error("packageRepository is required to bind a thread to an agent");
    }
    const resolved = await deps.packageRepository.getAgentWithLinkedSkills(
      args.projectId,
      args.userId,
      agentSlug,
    );
    if (!resolved.agent) {
      throw new AgentBindingNotFoundError(agentSlug);
    }
  }

  let resolvedWorkId: string | null = null;
  const thread = await deps.transaction(async () => {
    const created = await deps.threads.create({
      id: args.id ? args.id : undefined,
      userId: args.userId,
      projectId: args.projectId,
      title: args.title ?? null,
      systemPrompt: agentSlug ? null : (args.systemPrompt ?? null),
      currentAgent: agentSlug,
      parentThreadId: args.parentThreadId,
    });
    resolvedWorkId = await resolveWorkMembership(
      { workRepo: deps.workRepo, threadWorks: deps.threadWorks },
      {
        threadId: created.id,
        projectId: args.projectId,
        project,
        userId: args.userId,
        workId: args.workId,
        parentThreadId: args.parentThreadId,
      },
    );
    return { ...created, workId: resolvedWorkId };
  });

  if (resolvedWorkId) {
    try {
      await deps.workRepo.touch(resolvedWorkId);
    } catch (error) {
      emitEvent(eventSink, {
        level: "warn",
        source: "lib.thread-creation",
        name: "work_touch.failed",
        payload: {
          threadId: thread.id,
          projectId: args.projectId,
          workId: resolvedWorkId,
          ...unknownToEventPayload(error),
        },
      });
    }
  }
  return thread;
}
