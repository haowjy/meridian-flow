/**
 * Thread-creation orchestration helper: creates a thread for a project after
 * asserting ownership and resolving its work attachment. App-layer glue tying
 * the projects + threads + packages domains together.
 */
import type { AgentSelection } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import {
  type AgentRevisionStore,
  AgentSelectionError,
  type BoundAgentCatalog,
} from "../domains/packages/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  WorkLifecycleUnavailableError,
  type WorkRepository,
} from "../domains/projects/index.js";
import {
  createBoundConversation,
  threadAvailabilityCode,
  throwThreadDeleted,
} from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { InvalidWorkAttachmentError, resolveRootWork } from "./work-attachment.js";

export { InvalidWorkAttachmentError } from "./work-attachment.js";

export class ThreadCreationConflictError extends Error {
  constructor() {
    super("This thread ID is already used in another project");
  }
}

export class ThreadCreationNotFoundError extends Error {
  constructor() {
    super("Not found");
  }
}

export interface CreateThreadForProjectDeps {
  projects: ProjectRepository;
  workRepo: WorkRepository;
  threads: ThreadRepositories["threads"];
  threadWorks: ThreadRepositories["threadWorks"];
  transaction: ThreadRepositories["transaction"];
  agentRevisions: AgentRevisionStore;
  agentCatalog: BoundAgentCatalog;
  eventSink: EventSink;
}

export interface CreateThreadForProjectArgs {
  projectId: string;
  userId: string;
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  title?: string | null;
  agentSelection: AgentSelection;
  /** Explicit work assignment from the request, if any. */
  workId?: string | null;
  /** The writer's explicit mode; it also becomes the Work's default. Omitted, the chat copies it. */
  aiWriteMode?: AiWriteMode;
}

/**
 * Create a thread under a project — the single owner of thread-creation policy
 * shared by both the global (`/api/threads`) and project-scoped
 * (`/api/projects/:projectId/threads`) routes. Verifies ownership, persists the
 * thread row in the mode the request chose or its Work's default, then creates its primary Work
 * membership. Throws (404) if the caller
 * does not own the project.
 */
export async function createThreadForProject(
  deps: CreateThreadForProjectDeps,
  args: CreateThreadForProjectArgs,
): Promise<Thread> {
  const eventSink = deps.eventSink;

  const existingById = async (): Promise<Thread | null> => {
    const existing = args.id ? await deps.threads.lockByIdIncludingDeleted(args.id) : null;
    if (!existing) return null;
    const { deletedByWorkId: _deletedByWorkId, ...thread } = existing;
    return thread;
  };

  const ownedExisting = async (existing: Thread): Promise<Thread> => {
    const project = await deps.projects.findById(existing.projectId);
    const code = threadAvailabilityCode(existing, project, args.userId);
    if (code === "thread_not_found") throw new ThreadCreationNotFoundError();
    if (code === "thread_deleted") throwThreadDeleted(args.userId, !!project?.deletedAt);
    if (existing.projectId !== args.projectId) throw new ThreadCreationConflictError();
    return existing;
  };

  const existing = await existingById();
  if (existing) return ownedExisting(existing);
  await requireProjectOwner({ projects: deps.projects }, args.projectId, args.userId);
  let work!: Work;
  let thread: Thread;
  try {
    const resolved = await deps.agentCatalog.resolvePrimary(
      args.userId,
      args.agentSelection,
      args.projectId,
    );
    if (!resolved.ok) throw new AgentSelectionError(args.agentSelection.definitionRevisionId);
    const { revision, configuration } = resolved;

    thread = await createBoundConversation({
      transaction: deps.transaction,
      agentRevisions: deps.agentRevisions,
      revision,
      configuration,
      createThread: async () => {
        work = await resolveRootWork(
          { workRepo: deps.workRepo },
          { projectId: args.projectId, workId: args.workId },
        );
        return deps.threads.create({
          id: args.id,
          userId: args.userId,
          projectId: args.projectId,
          title: args.title ?? null,
          aiWriteMode: args.aiWriteMode ?? work.aiWriteMode,
        });
      },
      resolveWork: async (created) => {
        await deps.threadWorks.addMembership(created.id, work.id, true);
        // An explicit choice becomes the Work's default; lock order is thread, then Work.
        if (args.aiWriteMode) await deps.workRepo.setDefaultAiWriteMode(work.id, args.aiWriteMode);
        return work.id;
      },
    });
  } catch (error) {
    const committed = await existingById();
    if (committed) return ownedExisting(committed);
    if (error instanceof WorkLifecycleUnavailableError) {
      throw new InvalidWorkAttachmentError("Work is not available in this project");
    }
    throw error;
  }

  try {
    await deps.workRepo.touch(work.id);
  } catch (error) {
    emitEvent(eventSink, {
      level: "warn",
      source: "lib.thread-creation",
      name: "work_touch.failed",
      payload: {
        threadId: thread.id,
        projectId: args.projectId,
        workId: work.id,
        ...unknownToEventPayload(error),
      },
    });
  }
  return thread;
}
