/**
 * Thread-creation orchestration helper: creates a thread for a project after
 * asserting ownership and resolving its work attachment. App-layer glue tying
 * the projects + threads + packages domains together.
 */
import type { AgentSelection } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";
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
import { createBoundConversation } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { InvalidWorkAttachmentError, resolveWorkMembership } from "./work-attachment.js";

export { InvalidWorkAttachmentError } from "./work-attachment.js";

export class ThreadCreationConflictError extends Error {
  constructor() {
    super("The reserved thread ID belongs to a different creation");
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
  await requireProjectOwner({ projects: deps.projects }, args.projectId, args.userId);

  const recoverCommitted = async (): Promise<Thread | null> => {
    const existing = args.id ? await deps.threads.findById(args.id) : null;
    if (!existing) return null;
    if (
      existing.projectId !== args.projectId ||
      existing.userId !== args.userId ||
      existing.kind !== "primary" ||
      existing.title !== (args.title || null) ||
      existing.workId !== (args.workId ?? null) ||
      existing.parentThreadId !== null ||
      existing.agentDefinitionRevisionId !== args.agentSelection.definitionRevisionId
    )
      throw new ThreadCreationConflictError();
    return existing;
  };
  // Recovery uses committed identity even if prospective catalog eligibility has changed.
  const existing = await recoverCommitted();
  if (existing) return existing;
  let resolvedWorkId: string | null = null;
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
      createThread: () =>
        deps.threads.create({
          id: args.id,
          userId: args.userId,
          projectId: args.projectId,
          title: args.title ?? null,
          systemPrompt: null,
          currentAgent: revision.slug,
        }),
      resolveWork: async (created) => {
        resolvedWorkId = await resolveWorkMembership(
          { workRepo: deps.workRepo, threadWorks: deps.threadWorks },
          { threadId: created.id, projectId: args.projectId, workId: args.workId },
        );
        return resolvedWorkId;
      },
    });
  } catch (error) {
    const committed = await recoverCommitted();
    if (committed) return committed;
    if (error instanceof WorkLifecycleUnavailableError) {
      throw new InvalidWorkAttachmentError("Work is not available in this project");
    }
    throw error;
  }

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
