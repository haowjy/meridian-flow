// @ts-nocheck
/**
 * Thread-creation orchestration helper: creates a thread for a workbench after
 * asserting ownership and resolving its work attachment. App-layer glue tying
 * the workbenches + threads + packages domains together.
 */
import type { Thread } from "@meridian/contracts/protocol";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { PackageRepository } from "../domains/packages/index.js";
import {
  requireWorkbenchOwner,
  type WorkbenchRepository,
  type WorkRepository,
} from "../domains/workbenches/index.js";
import type { ThreadRepositories } from "./compose.js";
import { resolveWorkIdForThread } from "./work-attachment.js";

export class AgentBindingNotFoundError extends Error {
  constructor(public readonly agentSlug: string) {
    super(`Agent not found: ${agentSlug}`);
    this.name = "AgentBindingNotFoundError";
  }
}

export interface CreateThreadForWorkbenchDeps {
  workbenches: WorkbenchRepository;
  workRepo: WorkRepository;
  threads: ThreadRepositories["threads"];
  packageRepository?: PackageRepository;
  eventSink: EventSink;
}

export interface CreateThreadForWorkbenchArgs {
  workbenchId: string;
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
 * Create a thread under a workbench — the single owner of thread-creation policy
 * shared by both the global (`/api/threads`) and workbench-scoped
 * (`/api/workbenches/:workbenchId/threads`) routes. Verifies ownership, resolves the
 * work the thread attaches to, then persists. Throws (404) if the caller does
 * not own the workbench.
 */
export async function createThreadForWorkbench(
  deps: CreateThreadForWorkbenchDeps,
  args: CreateThreadForWorkbenchArgs,
): Promise<Thread> {
  const eventSink = deps.eventSink;
  const workbench = await requireWorkbenchOwner(
    { workbenches: deps.workbenches },
    args.workbenchId,
    args.userId,
  );

  const workId = await resolveWorkIdForThread(
    { workRepo: deps.workRepo, threads: deps.threads },
    {
      workbenchId: args.workbenchId,
      workId: args.workId,
      parentThreadId: args.parentThreadId,
      defaultTitle: workbench.title,
    },
  );

  const agentSlug = args.currentAgent ?? null;
  if (agentSlug) {
    if (!deps.packageRepository) {
      throw new Error("packageRepository is required to bind a thread to an agent");
    }
    const resolved = await deps.packageRepository.getAgentWithLinkedSkills(
      args.workbenchId,
      args.userId,
      agentSlug,
    );
    if (!resolved.agent) {
      throw new AgentBindingNotFoundError(agentSlug);
    }
  }

  const thread = await deps.threads.create({
    id: args.id ? args.id : undefined,
    userId: args.userId,
    workbenchId: args.workbenchId,
    workId,
    title: args.title ?? null,
    systemPrompt: agentSlug ? null : (args.systemPrompt ?? null),
    currentAgent: agentSlug,
  });

  if (workId) {
    try {
      await deps.workRepo.touch(workId);
    } catch (error) {
      emitEvent(eventSink, {
        level: "warn",
        source: "lib.thread-creation",
        name: "work_touch.failed",
        payload: {
          threadId: thread.id,
          workbenchId: args.workbenchId,
          workId,
          ...unknownToEventPayload(error),
        },
      });
    }
  }
  return thread;
}
