/**
 * ContextPort resolution helpers: centralize the active-Work lookup that turns
 * thread or project-browse context into the correct unified ContextPort.
 */
import type { Thread } from "@meridian/contracts/threads";
import type { WorkRepository } from "../projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../threads/index.js";
import type { ContextPort } from "./ports/context-port.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

export interface ThreadContextResolution {
  thread: Thread;
  primaryWorkId: string | null;
  workMemberships: ReadonlySet<string>;
}

export interface ThreadContextResolutionDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const primaryMembership = await deps.threadWorks.findPrimary(thread.id);
  if (!primaryMembership) {
    return { thread, primaryWorkId: null, workMemberships: new Set() };
  }

  const allMemberships = await deps.threadWorks.listByThread(thread.id);
  return {
    thread,
    primaryWorkId: primaryMembership.workId,
    workMemberships: new Set(allMemberships.map((membership) => membership.workId)),
  };
}

export function contextPortForThread(
  contextPorts: UnifiedContextPortFactory,
  resolution: ThreadContextResolution,
  options: { responseId?: string | null } = {},
): ContextPort {
  if (resolution.primaryWorkId) {
    return contextPorts.forWork(
      resolution.primaryWorkId,
      resolution.thread.projectId,
      resolution.thread.userId,
      resolution.workMemberships,
      resolution.thread.id,
      options.responseId,
    );
  }
  return contextPorts.forProject(resolution.thread.projectId, resolution.thread.userId);
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  works: Pick<WorkRepository, "findById">;
}

/**
 * Resolve a route-level context port after the caller has already proven
 * project ownership. The singleton authority set rejects authority-addressed
 * URIs for any other Work.
 */
export async function contextPortForProjectBrowse(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  workId?: string | null;
}): Promise<ContextPort | null> {
  if (!input.workId) return input.deps.contextPorts.forProject(input.projectId, input.userId);

  const work = await input.deps.works.findById(input.workId);
  if (!work || work.deletedAt || work.projectId !== input.projectId) return null;
  return input.deps.contextPorts.forWork(
    input.workId,
    input.projectId,
    input.userId,
    new Set([input.workId]),
  );
}
